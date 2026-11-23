// `pnpm adr:apply [--approved <file>]`: applies scripts/adr-triage/approved.json
// to the working tree. It writes each ADR to <home>/NNNN-<slug>.md, numbered
// per directory in approved.json's order after any ADR already there, from
// drafts/<key>.md. At each ADR site it replaces the Decision comment with a
// two-line pointer (the gist, then the ADR's path from the repo root); at each
// comment site it removes only the tag and capitalises a plain first word.
// Each site is found by its comment text in the current file, nearest its
// snapshot line, so a comment that moved still lands. A site in a D1 migration
// is left as written: Alchemy refuses to deploy an applied migration edited
// even in a comment. An ADR whose every site is in one takes `Sites: none`. It
// refuses a dirty tree, and fails before writing anything if a site's text is
// gone or a Decision in the tree has no row.
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Stdio } from "effect/Stdio"

import { anyTag } from "../decision-docs.mts"
import { CheckFailed, repoRoot } from "../lib/check.mts"
import { gitLines } from "../lib/command.mts"
import { runScript } from "../lib/run.mts"
import {
  Approved,
  decisionsIn,
  parseOptions,
  pathspec,
  readManifests,
  tag,
  triageDir,
} from "./triage.mts"

const USAGE = "Usage: pnpm adr:apply [--approved <file>]"
const adrName = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/
const lineMarkers = new Set(["//", "#", "--"])
const blockOpen = /^\{?\/\*\*?$/
const migration = /\.sql:\d+$/
const inMigration = (site: string) => migration.test(site)

type Decision = (typeof Approved.Type)["decisions"][number]

interface Row {
  readonly site: string
  readonly file: string
  readonly line: number
  readonly comment: string
}

interface Span {
  readonly file: string
  readonly line: number
  readonly endLine: number
  readonly comment: string
}

interface Adr {
  readonly decision: Decision
  readonly file: string
}

// A site's edit: a pointer to its ADR, or (no ADR) the tag removed.
interface Edit {
  readonly span: Span
  readonly adr: Adr | null
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

// The first word upper-cased when it is a plain lower-case word; an
// identifier, a quote or a number stays as written.
const capitalise = (text: string) =>
  /^[a-z]+(?:'[a-z]+)?(?=[\s,.;:]|$)/.test(text)
    ? `${text[0]!.toUpperCase()}${text.slice(1)}`
    : text

// The text before a block comment's second line: its own indent (and `*`),
// or, for a one-line decision, spaces under the first line's text.
const continuation = (
  lines: ReadonlyArray<string>,
  span: Span,
  prefix: string
) => {
  if (prefix.trim() === "*") return prefix
  const next = lines[span.line]
  return span.endLine > span.line && next !== undefined
    ? (/^\s*(?:\*(?!\/)\s*)?/.exec(next)?.[0] ?? "")
    : " ".repeat(prefix.length)
}

// The two pointer lines that replace a decision's lines, in its comment's
// syntax: the text before the tag opens the first, and a block comment's
// close ends the second. A string names why it cannot be written.
const pointerLines = (
  lines: ReadonlyArray<string>,
  span: Span,
  adr: Adr
): ReadonlyArray<string> | string => {
  const head = lines[span.line - 1] ?? ""
  const at = head.search(anyTag)
  const prefix = head.slice(0, at)
  const marker = prefix.trim()
  const first = `${prefix}${tag} ${adr.decision.gist}`
  const second = `(${adr.file})`
  if (lineMarkers.has(marker))
    return lines
      .slice(span.line, span.endLine)
      .every((line) => line.trimStart().startsWith(marker))
      ? [first, `${prefix}${second}`]
      : `a line in it does not open with ${marker}`
  if (!blockOpen.test(marker) && marker !== "*")
    return `its tag follows ${JSON.stringify(marker)}, no known comment opener`
  const last = lines[span.endLine - 1] ?? ""
  const close = last.indexOf("*/", span.endLine === span.line ? at : 0)
  const suffix = close < 0 ? "" : ` ${last.slice(close)}`
  return [first, `${continuation(lines, span, prefix)}${second}${suffix}`]
}

// The tag line with the tag gone and its first word capitalised.
const untagged = (lines: ReadonlyArray<string>, span: Span) => {
  const head = lines[span.line - 1] ?? ""
  const at = head.search(anyTag)
  const rest = head.slice(at + tag.length).trimStart()
  return rest === ""
    ? "the tag ends its line"
    : [`${head.slice(0, at)}${capitalise(rest)}`]
}

// A file's text with its edits made from the bottom, so line numbers hold.
const rewrite = (text: string, edits: ReadonlyArray<Edit>) => {
  const lines = text.split("\n")
  const problems: Array<string> = []
  for (const { span, adr } of [...edits].sort(
    (a, b) => b.span.line - a.span.line
  )) {
    const replaced =
      adr === null ? untagged(lines, span) : pointerLines(lines, span, adr)
    if (typeof replaced === "string")
      problems.push(`${span.file}:${span.line}: ${replaced}`)
    else
      lines.splice(
        span.line - 1,
        adr === null ? 1 : span.endLine - span.line + 1,
        ...replaced
      )
  }
  return { text: lines.join("\n"), problems }
}

// The draft as the ADR: the approved title, the approved sites' files, and
// `Sites: none` frontmatter when no site can take a pointer.
const renderAdr = (draft: string, decision: Decision) => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(draft)
  const fields = (fm?.[1] ?? "")
    .split("\n")
    .filter((line) => line !== "" && !/^sites:/i.test(line))
  if (decision.sitesNone || decision.sites.every(inMigration))
    fields.push("Sites: none")
  const titled = (fm === null ? draft : draft.slice(fm[0].length)).trimStart()
  const body = /^# .*$/m.test(titled)
    ? titled.replace(/^# .*$/m, `# ${decision.title}`)
    : `# ${decision.title}\n\n${titled}`
  const files = [
    ...new Set(decision.sites.map((site) => site.replace(/:\d+$/, ""))),
  ]
  const list = files.map((file) => `- \`${file}\``).join("\n")
  const block = files.length === 0 ? "" : `Sites:\n${list}\n\n`
  const sites = /^Sites:\n(?:- .*(?:\n|$))*\n?/m
  const listed = sites.test(body)
    ? body.replace(sites, block)
    : `${body.trimEnd()}\n\n${block}`
  const head = fields.length === 0 ? "" : `---\n${fields.join("\n")}\n---\n\n`
  return `${head}${listed.trimEnd()}\n`
}

// Lines `git status` shows, but for approved.json, which may be new.
const dirtyLines = Effect.fnUntraced(function* (
  root: string,
  approvedFile: string
) {
  const path = yield* Path.Path
  const status = yield* gitLines(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ])
  return status.filter(
    (line) => path.resolve(root, line.slice(3)) !== approvedFile
  )
})

// Each site once, in a decision's sites (with it) or in comments (null).
const placeSites = (
  approved: typeof Approved.Type,
  rows: ReadonlyMap<string, Row>
) => {
  const calls = new Map<string, Decision | null>()
  const problems: Array<string> = []
  const place = (site: string, decision: Decision | null) => {
    if (!rows.has(site)) problems.push(`${site}: in no manifest`)
    else if (calls.has(site)) problems.push(`${site}: listed twice`)
    else calls.set(site, decision)
  }
  for (const decision of approved.decisions)
    for (const site of decision.sites) place(site, decision)
  for (const site of approved.comments) place(site, null)
  for (const site of rows.keys())
    if (!calls.has(site)) problems.push(`${site}: in neither list`)
  return { calls, problems }
}

// Each ADR's path, numbered after the ADRs already in its directory.
const numberAdrs = Effect.fnUntraced(function* (
  root: string,
  decisions: ReadonlyArray<Decision>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const next = new Map<string, number>()
  const adrs = new Map<string, Adr>()
  for (const decision of decisions) {
    const names = next.has(decision.home)
      ? []
      : yield* Effect.orElseSucceed(
          fs.readDirectory(path.join(root, decision.home)),
          () => []
        )
    const taken = names.map((name) => Number(adrName.exec(name)?.[1] ?? 0))
    const number = next.get(decision.home) ?? Math.max(0, ...taken) + 1
    next.set(decision.home, number + 1)
    const name = `${String(number).padStart(4, "0")}-${decision.slug}.md`
    adrs.set(decision.key, { decision, file: path.join(decision.home, name) })
  }
  return adrs
})

// The Decision comments in the tree now: in every file `git grep` finds the
// tag in, and every file a row names.
const currentSpans = Effect.fnUntraced(function* (
  root: string,
  rowFiles: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = new Set([
    ...(yield* gitLines(root, ["grep", "-l", "-e", tag, ...pathspec])),
    ...rowFiles,
  ])
  const texts = new Map<string, string>()
  const spans: Array<Span> = []
  const problems: Array<string> = []
  for (const file of files) {
    const text = yield* Effect.option(fs.readFileString(path.join(root, file)))
    if (Option.isNone(text)) continue
    texts.set(file, text.value)
    const found = yield* decisionsIn(file, text.value, [])
    if (!found.parsed) problems.push(`${file}: does not parse`)
    spans.push(...found.decisions)
  }
  return { texts, spans, problems }
})

// Each row's comment in the tree: same file and text, nearest its old line.
// A migration's rows are left as written.
const matchRows = (
  calls: ReadonlyMap<string, Decision | null>,
  rows: ReadonlyMap<string, Row>,
  spans: ReadonlyArray<Span>,
  adrs: ReadonlyMap<string, Adr>
) => {
  const claimed = new Set<Span>()
  const edits: Array<Edit> = []
  const problems: Array<string> = []
  let moved = 0
  for (const [site, decision] of calls) {
    if (inMigration(site)) continue
    const row = rows.get(site)!
    const want = collapse(row.comment)
    const span = spans
      .filter(
        (each) =>
          each.file === row.file &&
          !claimed.has(each) &&
          collapse(each.comment) === want
      )
      .sort(
        (a, b) => Math.abs(a.line - row.line) - Math.abs(b.line - row.line)
      )[0]
    if (span === undefined) {
      problems.push(`${site}: its comment text is no longer in ${row.file}`)
      continue
    }
    claimed.add(span)
    if (span.line !== row.line) moved += 1
    edits.push({
      span,
      adr: decision === null ? null : adrs.get(decision.key)!,
    })
  }
  for (const span of spans)
    if (!claimed.has(span))
      problems.push(
        `${span.file}:${span.line}: a Decision no manifest row names; run the catch-up`
      )
  return { edits, moved, problems }
}

// Each ADR's text from its draft.
const renderAdrs = Effect.fnUntraced(function* (
  root: string,
  adrs: ReadonlyMap<string, Adr>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rendered = new Map<string, string>()
  const problems: Array<string> = []
  for (const { decision, file } of adrs.values()) {
    const draftFile = path.join(root, triageDir, "drafts", `${decision.key}.md`)
    const draft = yield* Effect.option(fs.readFileString(draftFile))
    if (!adrName.test(path.basename(file)))
      problems.push(`${file}: not an NNNN-slug.md name`)
    if (Option.isNone(draft)) problems.push(`${decision.key}: no draft`)
    else if (yield* fs.exists(path.join(root, file)))
      problems.push(`${file}: exists already`)
    else rendered.set(file, renderAdr(draft.value, decision))
  }
  return { rendered, problems }
})

const apply = Effect.fn("apply")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const { values } = yield* parseOptions(USAGE, args, {
    approved: { type: "string" },
  })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const approvedFile = path.resolve(
    root,
    values.approved ?? path.join(triageDir, "approved.json")
  )
  // Applying twice would number a second set of ADRs; a clean tree means
  // the last apply was committed or thrown away.
  const dirty = yield* dirtyLines(root, approvedFile)
  if (dirty.length > 0)
    return yield* new CheckFailed({
      summary: "Apply runs on a clean tree only; commit or restore these:",
      findings: dirty,
    })

  const approved = yield* Effect.flatMap(
    fs.readFileString(approvedFile),
    Schema.decodeEffect(Approved)
  )
  const manifests = yield* readManifests(root)
  const rows = new Map(manifests.rows.map((row) => [row.site, row]))
  const placed = placeSites(approved, rows)
  const adrs = yield* numberAdrs(root, approved.decisions)
  const current = yield* currentSpans(
    root,
    manifests.rows.map((row) => row.file)
  )
  const matched = matchRows(placed.calls, rows, current.spans, adrs)
  const files = [...current.texts].flatMap(([file, text]) => {
    const own = matched.edits.filter((edit) => edit.span.file === file)
    return own.length === 0 ? [] : [{ file, ...rewrite(text, own) }]
  })
  const adrTexts = yield* renderAdrs(root, adrs)
  const problems = [
    ...placed.problems,
    ...current.problems,
    ...matched.problems,
    ...files.flatMap((file) => file.problems),
    ...adrTexts.problems,
  ]
  if (problems.length > 0)
    return yield* new CheckFailed({
      summary: `approved.json does not apply to this tree (${problems.length} problems); nothing written:`,
      findings: problems,
    })

  for (const [file, text] of adrTexts.rendered) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
      recursive: true,
    })
    yield* fs.writeFileString(path.join(root, file), text)
  }
  for (const { file, text } of files)
    yield* fs.writeFileString(path.join(root, file), text)

  const pointers = matched.edits.filter((edit) => edit.adr !== null).length
  const pointerSites = approved.decisions.flatMap((d) => d.sites)
  const editable = (sites: ReadonlyArray<string>) =>
    sites.filter((site) => !inMigration(site)).length
  const counts = [
    ["ADRs written", adrTexts.rendered.size, approved.decisions.length],
    ["pointers placed", pointers, editable(pointerSites)],
    [
      "tags removed",
      matched.edits.length - pointers,
      editable(approved.comments),
    ],
  ] as const
  yield* Console.log(
    `Applied ${approvedFile} over ${manifests.rows.length} manifest rows (${manifests.names.join(", ")}):`
  )
  for (const [label, done, want] of counts)
    yield* Console.log(`  ${label}: ${done} of ${want}`)
  yield* Console.log(
    `  left in migrations: ${pointerSites.length - editable(pointerSites)} ADR sites, ${approved.comments.length - editable(approved.comments)} comment sites`
  )
  yield* Console.log(
    `  files edited: ${files.length}; comments found off their snapshot line: ${matched.moved}`
  )
  if (counts.some(([, done, want]) => done !== want))
    return yield* new CheckFailed({
      summary: "A count falls short of approved.json.",
      findings: [],
    })
})

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* apply(yield* repoRoot, args)
  })
)
