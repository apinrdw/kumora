// `pnpm adr:approve [--verdicts <file>] [--out <file>]`: turns the owner's
// review into scripts/adr-triage/approved.json, the manifest apply reads.
// Inputs: every decisions*.json and manifest*.json in scripts/adr-triage, and
// the verdicts file (~/.t3/notes/kumora/643/verdicts.json by default):
//
//   { "<decision key>": "agree" | "flip",
//     "<site>": "adr" | "comment",
//     "overrides": { "<decision key>": { title?, home?, slug?, gist?, sites? } } }
//
// A flipped decision is dropped and its sites become comments. A site marked
// `comment` leaves its decision; one marked `adr` stays in (or, through an
// override's sites, joins) one. A borderline site with no verdict is a
// comment, and so is a flipped decision's; any other agreed row keeps its call. A decision left with no sites is
// dropped unless it is `sitesNone`. A site the catch-up found gone leaves its
// decision. Every manifest site lands exactly once.
import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { Stdio } from "effect/Stdio"

import { CheckFailed, repoRoot } from "../lib/check.mts"
import { runScript } from "../lib/run.mts"
import {
  notesDir,
  parseOptions,
  readDecisions,
  readManifests,
  snapshot,
  triageDir,
  type Approved,
  type Decisions,
} from "./triage.mts"

const USAGE = "Usage: pnpm adr:approve [--verdicts <file>] [--out <file>]"

const Override = Schema.Struct({
  title: Schema.optional(Schema.String),
  home: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  gist: Schema.optional(Schema.String),
  sites: Schema.optional(Schema.Array(Schema.String)),
})

// The verdicts file: a call per decision key or site, and `overrides`.
const Verdicts = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown)
)
const Overrides = Schema.Record(Schema.String, Override)

type Proposed = (typeof Decisions.Type)[number]
type Kept = (typeof Approved.Type)["decisions"][number]
interface Row {
  readonly borderline: boolean
  readonly opus: { readonly call: string }
}

interface Review {
  readonly rows: ReadonlyMap<string, Row>
  // The sites a catch-up manifest lists as removed or changed.
  readonly gone: ReadonlySet<string>
  // The sites of the decisions the owner flipped.
  readonly flipped: ReadonlySet<string>
  readonly verdicts: Readonly<Record<string, unknown>>
  readonly overrides: typeof Overrides.Type
  readonly problems: Array<string>
}

// Verdicts and overrides that name nothing, or give a site a decision's call.
const strayVerdicts = (
  { rows, verdicts, overrides }: Review,
  keys: ReadonlySet<string>
) => [
  ...Object.entries(verdicts).flatMap(([key, verdict]) => {
    const fits = keys.has(key)
      ? verdict === "agree" || verdict === "flip"
      : rows.has(key) && (verdict === "adr" || verdict === "comment")
    return fits ? [] : [`verdicts: ${key}: ${String(verdict)} fits nothing`]
  }),
  ...Object.keys(overrides).flatMap((key) =>
    keys.has(key) ? [] : [`overrides: ${key}: no such decision`]
  ),
]

// A site's call: its verdict, else comment for a flipped decision's site, else
// adr for an agreed adr row, else comment.
const callOf = ({ rows, flipped, verdicts }: Review, site: string) => {
  const verdict = verdicts[site]
  if (verdict === "adr" || verdict === "comment") return verdict
  if (flipped.has(site)) return "comment"
  const row = rows.get(site)
  return row !== undefined && !row.borderline && row.opus.call === "adr"
    ? "adr"
    : "comment"
}

// The decision as approved, or none when it is flipped or left with no site.
const keep = (review: Review, decision: Proposed): ReadonlyArray<Kept> => {
  const { rows, gone, verdicts, problems } = review
  if (verdicts[decision.key] === "flip") return []
  const listed = review.overrides[decision.key]?.sites
  const sites = (listed ?? decision.sites).filter((site) => {
    if (!rows.has(site)) {
      if (!gone.has(site))
        problems.push(`${decision.key}: site ${site} is in no manifest`)
      return false
    }
    // An override's sites are the owner's list: each one is an adr call.
    if (listed === undefined) return callOf(review, site) === "adr"
    if (verdicts[site] === "comment")
      problems.push(`${decision.key}: override lists ${site}, marked comment`)
    return true
  })
  if (sites.length === 0 && !decision.sitesNone) return []
  const { title, home, slug, gist } = {
    ...decision,
    ...review.overrides[decision.key],
  }
  if (/\n|\*\//.test(gist))
    problems.push(`${decision.key}: gist holds a newline or */`)
  return [
    {
      key: decision.key,
      title,
      home,
      slug,
      sites,
      gist,
      sitesNone: decision.sitesNone,
    },
  ]
}

// Each site's one place: a kept decision, or the comments.
const resolve = (
  review: Review,
  rowSites: ReadonlyArray<string>,
  decisions: ReadonlyArray<Proposed>
) => {
  const kept = decisions.flatMap((decision) => keep(review, decision))
  const placed = new Map<string, string>()
  for (const { key, sites } of kept)
    for (const site of sites) {
      const other = placed.get(site)
      if (other !== undefined)
        review.problems.push(`${site}: in both ${other} and ${key}`)
      placed.set(site, key)
    }
  const comments = rowSites.filter((site) => !placed.has(site))
  for (const site of comments)
    if (callOf(review, site) === "adr")
      review.problems.push(`${site}: called adr, but no kept decision lists it`)
  return { kept, comments, sites: placed.size }
}

const approve = Effect.fn("approve")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const { values } = yield* parseOptions(USAGE, args, {
    verdicts: { type: "string" },
    out: { type: "string" },
  })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const verdictsFile =
    values.verdicts ?? path.join(yield* notesDir(false), "verdicts.json")
  const out = path.resolve(
    root,
    values.out ?? path.join(triageDir, "approved.json")
  )

  const manifests = yield* readManifests(root)
  const { names, decisions } = yield* readDecisions(root)
  const { overrides = {}, ...verdicts } = yield* Effect.flatMap(
    fs.readFileString(verdictsFile),
    Schema.decodeEffect(Verdicts)
  )
  const review: Review = {
    rows: new Map(manifests.rows.map((row) => [row.site, row])),
    gone: manifests.gone,
    flipped: new Set(
      decisions.flatMap((decision) =>
        verdicts[decision.key] === "flip" ? decision.sites : []
      )
    ),
    verdicts,
    overrides: yield* Schema.decodeUnknownEffect(Overrides)(overrides),
    problems: [],
  }
  const keys = new Set(decisions.map((decision) => decision.key))
  if (review.rows.size !== manifests.rows.length)
    review.problems.push("a site appears in two manifest rows")
  if (keys.size !== decisions.length)
    review.problems.push("a decision key appears twice")
  review.problems.push(...strayVerdicts(review, keys))
  const { kept, comments, sites } = resolve(
    review,
    manifests.rows.map((row) => row.site),
    decisions
  )
  if (review.problems.length > 0)
    return yield* new CheckFailed({
      summary: `The verdicts do not resolve to one call per site (${review.problems.length} problems); nothing written:`,
      findings: review.problems,
    })

  yield* fs.writeFileString(
    out,
    `${JSON.stringify({ snapshot, decisions: kept, comments }, null, 2)}\n`
  )
  const unjudged = decisions.filter(
    (decision) => !decision.tentative && verdicts[decision.key] === undefined
  )
  yield* Console.log(
    `Read ${manifests.rows.length} rows (${manifests.names.join(", ")}) and ${decisions.length} decisions (${names.join(", ")}).`
  )
  if (unjudged.length > 0)
    yield* Console.log(
      `  ${unjudged.length} proposed decisions had no verdict and were kept`
    )
  yield* Console.log(
    `Wrote ${out}: ${kept.length} ADRs over ${sites} sites, ${comments.length} comments (${sites + comments.length} of ${manifests.rows.length} rows).`
  )
})

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* approve(yield* repoRoot, args)
  })
)
