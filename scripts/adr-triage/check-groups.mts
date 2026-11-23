// `pnpm adr:check-groups`: checks scripts/adr-triage/decisions.json against
// the manifest. Every row both judges called adr, and every borderline row,
// sits in exactly one decision; a decision is tentative exactly when all its
// rows are borderline; its home follows the spec's location rule. Prints the
// decision count, the tentative count and the count per home.
import { Console, Effect, FileSystem, Path, Schema } from "effect"

import { CheckFailed, repoRoot } from "../lib/check.mts"
import { runScript } from "../lib/run.mts"
import { Decisions } from "./triage.mts"

const maxGist = 70
const rootHome = "docs/adr"

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    rows: Schema.Array(
      Schema.Struct({
        site: Schema.String,
        workspace: Schema.String,
        borderline: Schema.Boolean,
        opus: Schema.Struct({ call: Schema.String }),
        fable: Schema.Struct({ call: Schema.String }),
      })
    ),
  })
)

const PackageJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(
      Schema.Record(Schema.String, Schema.String)
    ),
  })
)

type Decision = (typeof Decisions.Type)[number]

const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const homeOf = (workspace: string) =>
  workspace === "." ? rootHome : `${workspace}/docs/adr`

// Each workspace folder with the workspace folders it depends on, itself
// included: the contexts its sites may share a decision through.
const workspaceReach = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const folders = (yield* Effect.forEach(["apps", "packages"], (group) =>
    Effect.map(fs.readDirectory(path.join(root, group)), (names) =>
      names.map((name) => `${group}/${name}`)
    )
  )).flat()
  const packages = yield* Effect.forEach(folders, (folder) =>
    Effect.map(
      Effect.flatMap(
        fs.readFileString(path.join(root, folder, "package.json")),
        Schema.decodeEffect(PackageJson)
      ),
      (json) => ({ folder, json })
    )
  )
  const folderOf = new Map(
    packages.map(({ folder, json }) => [json.name, folder])
  )
  return new Map(
    packages.map(({ folder, json }) => {
      const deps = Object.entries({
        ...json.dependencies,
        ...json.devDependencies,
      }).flatMap(([name, spec]) => {
        const dep = folderOf.get(name)
        return spec.startsWith("workspace:") && dep !== undefined ? [dep] : []
      })
      return [folder, new Set([folder, ...deps])]
    })
  )
})

// What is wrong with one decision's home, given its sites' workspaces.
const homeProblem = (
  decision: Decision,
  workspaces: ReadonlySet<string>,
  reach: ReadonlyMap<string, ReadonlySet<string>>
) => {
  const [only] = workspaces
  if (workspaces.size === 1 && only !== undefined)
    return decision.home === homeOf(only)
      ? undefined
      : `${decision.key}: home ${decision.home}, but every site is in ${only}`
  if (decision.home === rootHome) return undefined
  const shared = [...workspaces].every((workspace) =>
    [...(reach.get(workspace) ?? [])].some(
      (folder) => homeOf(folder) === decision.home
    )
  )
  return shared
    ? undefined
    : `${decision.key}: home ${decision.home} is not a context every site (${[...workspaces].join(", ")}) depends on`
}

type Row = (typeof Manifest.Type)["rows"][number]

const keyOf = (decision: Decision) =>
  `${decision.home.replace(/\/?docs\/adr$/, "") || "root"}/${decision.slug}`

// Each rule a decision's own fields must keep, with the fault it names.
const fieldRules: ReadonlyArray<
  readonly [(decision: Decision) => boolean, string]
> = [
  [
    (decision) => decision.slug === slugOf(decision.title),
    "slug is not the title's kebab case",
  ],
  [
    (decision) => decision.key === keyOf(decision),
    "key is not <home context>/<slug>",
  ],
  [
    ({ gist }) =>
      gist.trim() !== "" && !gist.includes("\n") && gist.length <= maxGist,
    `gist must be one line of at most ${maxGist} chars`,
  ],
  [
    (decision) => decision.sitesNone === (decision.sites.length === 0),
    "sitesNone must be true exactly when there are no sites",
  ],
]

const decisionProblems = (
  decision: Decision,
  rows: ReadonlyMap<string, Row>,
  reach: ReadonlyMap<string, ReadonlySet<string>>
) => {
  const own = decision.sites.flatMap((site) => {
    const row = rows.get(site)
    return row === undefined ? [] : [row]
  })
  const problems = fieldRules
    .filter(([holds]) => !holds(decision))
    .map(([, fault]) => `${decision.key}: ${fault}`)
  if (
    own.length > 0 &&
    decision.tentative !== own.every((row) => row.borderline)
  )
    problems.push(
      `${decision.key}: tentative must be true exactly when every site is borderline`
    )
  const home = homeProblem(
    decision,
    new Set(own.map((row) => row.workspace)),
    reach
  )
  return home === undefined ? problems : [...problems, home]
}

// What is wrong with one site of a decision, given the sites seen before it.
const siteProblem = (
  site: string,
  key: string,
  seen: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
  rows: ReadonlyMap<string, Row>
) => {
  const before = seen.get(site)
  if (before !== undefined) return `${site}: in ${before} and ${key}`
  if (!known.has(site)) return `${site} (${key}): not a manifest row`
  if (!rows.has(site))
    return `${site} (${key}): agreed comment, not an adr or borderline row`
  return undefined
}

// Every grouped row in exactly one decision, and every decision's own faults.
const groupProblems = (
  decisions: typeof Decisions.Type,
  rows: ReadonlyMap<string, Row>,
  known: ReadonlySet<string>,
  reach: ReadonlyMap<string, ReadonlySet<string>>
) => {
  const problems: Array<string> = []
  const seen = new Map<string, string>()
  const keys = new Set<string>()
  for (const decision of decisions) {
    if (keys.has(decision.key)) problems.push(`${decision.key}: key repeats`)
    keys.add(decision.key)
    for (const site of decision.sites) {
      const problem = siteProblem(site, decision.key, seen, known, rows)
      if (problem !== undefined) problems.push(problem)
      seen.set(site, decision.key)
    }
    problems.push(...decisionProblems(decision, rows, reach))
  }
  const missing = [...rows.keys()].filter((site) => !seen.has(site))
  return [...problems, ...missing.map((site) => `${site}: in no decision`)]
}

const checkGroups = Effect.fn("checkGroups")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(root, "scripts/adr-triage")
  const manifest = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(dir, "manifest.json"))
  )
  const decisions = yield* Schema.decodeEffect(Decisions)(
    yield* fs.readFileString(path.join(dir, "decisions.json"))
  )
  const grouped = manifest.rows.filter(
    (row) =>
      row.borderline || (row.opus.call === "adr" && row.fable.call === "adr")
  )
  const problems = groupProblems(
    decisions,
    new Map(grouped.map((row) => [row.site, row])),
    new Set(manifest.rows.map((row) => row.site)),
    yield* workspaceReach(root)
  )
  if (problems.length > 0)
    return yield* new CheckFailed({
      summary: `decisions.json does not group the ADR and borderline rows one to one (${problems.length} problems):`,
      findings: problems,
    })

  const perHome = new Map<string, number>()
  for (const decision of decisions)
    perHome.set(decision.home, (perHome.get(decision.home) ?? 0) + 1)
  const borderline = grouped.filter((row) => row.borderline).length
  const tentative = decisions.filter((decision) => decision.tentative).length
  yield* Console.log(
    `${grouped.length} rows (${borderline} borderline) in ${decisions.length} decisions, ${tentative} tentative`
  )
  for (const [home, count] of [...perHome].sort((a, b) => b[1] - a[1]))
    yield* Console.log(`  ${home}: ${count}`)
})

runScript(Effect.flatMap(repoRoot, checkGroups))
