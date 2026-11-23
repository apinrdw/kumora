// `pnpm adr:merge [--dir <notes>] [--manifest <file>]`: joins every batch in
// <notes>/batches/ with the opus and fable rows in <notes>/judges/<judge>/,
// fails on any missing, extra, repeated or malformed row, and writes the
// manifest (scripts/adr-triage/manifest.json by default). A row is borderline
// where the two calls differ. A catch-up's <notes>/gone.json, the snapshot
// sites its extract found removed or changed, goes into the manifest as `gone`.
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Stdio } from "effect/Stdio"

import { CheckFailed, repoRoot } from "../lib/check.mts"
import { runScript } from "../lib/run.mts"
import {
  Batch,
  Gone,
  goneName,
  JudgeRows,
  judges,
  notesDir,
  parseOptions,
  snapshot,
  type Item,
} from "./triage.mts"

const USAGE = "Usage: pnpm adr:merge [--dir <notes>] [--manifest <file>]"
const maxGist = 72

type Row = (typeof JudgeRows.Type)[number]
type Judged = Readonly<Record<(typeof judges)[number], Row>>

// What is wrong with one row, and whether its gist runs long.
const rowProblems = (label: string, row: Row) => {
  const problems: Array<string> = []
  if ((row.call === "comment") !== (row.clause === "local"))
    problems.push(
      `${label}: ${row.id} calls ${row.call} with clause ${row.clause}; an adr names one of the four clauses, a comment names local`
    )
  const gist = row.gist.trim()
  if (gist === "" || gist.includes("\n"))
    problems.push(`${label}: ${row.id} needs a one-line gist`)
  const long =
    gist.length > maxGist
      ? [`${label}: ${row.id} gist is ${gist.length} chars`]
      : []
  return { problems, long }
}

// A judge's rows checked against the batch's ids: one row per id, no other.
const coverage = (
  label: string,
  rows: ReadonlyArray<Row>,
  ids: ReadonlySet<string>
) => {
  const seen = new Set<string>()
  const problems: Array<string> = []
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`${label}: ${row.id} has two rows`)
    else if (!ids.has(row.id))
      problems.push(`${label}: ${row.id} is not in the batch`)
    seen.add(row.id)
  }
  for (const id of ids)
    if (!seen.has(id)) problems.push(`${label}: no row for ${id}`)
  return problems
}

const call = ({ call: made, gist, clause }: Row) => ({
  call: made,
  gist: gist.trim(),
  clause,
})

const manifestRow = (item: typeof Item.Type, judged: Judged) => ({
  site: item.id,
  file: item.file,
  line: item.line,
  endLine: item.endLine,
  context: item.context,
  workspace: item.workspace,
  comment: item.comment,
  opus: call(judged.opus),
  fable: call(judged.fable),
  borderline: judged.opus.call !== judged.fable.call,
})

const summary = (rows: ReadonlyArray<ReturnType<typeof manifestRow>>) => {
  const total = rows.length
  const count = (keep: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(keep).length
  const borderline = count((row) => row.borderline)
  const agreed = total - borderline
  const bothAdr = count((row) => !row.borderline && row.opus.call === "adr")
  const percent =
    total === 0 ? "n/a" : `${((100 * agreed) / total).toFixed(1)}%`
  return [
    `  agreement: ${agreed}/${total} (${percent})`,
    `  borderline: ${borderline}`,
    `  agreed adr: ${bothAdr}, agreed comment: ${agreed - bothAdr}`,
    `  agreed calls that also agree on the clause: ${count((row) => !row.borderline && row.opus.clause === row.fable.clause)}`,
    ...judges.map(
      (judge) =>
        `  ${judge} adr calls: ${count((row) => row[judge].call === "adr")}`
    ),
  ]
}

// One judge's file for a batch, decoded, or what is wrong with it.
const readRows = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* Effect.option(fs.readFileString(file))
  if (Option.isNone(text)) return "missing" as const
  const rows = yield* Effect.option(Schema.decodeEffect(JudgeRows)(text.value))
  return Option.isNone(rows) ? ("malformed" as const) : rows.value
})

interface Findings {
  readonly problems: Array<string>
  readonly long: Array<string>
}

// One judge's rows for a batch, keyed by id, with their problems recorded.
const judgeRows = Effect.fnUntraced(function* (
  file: string,
  label: string,
  ids: ReadonlySet<string>,
  findings: Findings
) {
  const rows = yield* readRows(file)
  if (rows === "missing" || rows === "malformed") {
    findings.problems.push(
      rows === "missing"
        ? `${label}: missing`
        : `${label}: not a JSON array of {id, call, gist, clause} rows with known calls and clauses`
    )
    return new Map<string, Row>()
  }
  findings.problems.push(...coverage(label, rows, ids))
  for (const row of rows) {
    const found = rowProblems(label, row)
    findings.problems.push(...found.problems)
    findings.long.push(...found.long)
  }
  return new Map(rows.map((row) => [row.id, row]))
})

// A batch's manifest rows: the items both judges have a row for.
const joinBatch = Effect.fnUntraced(function* (
  dir: string,
  batch: typeof Batch.Type,
  findings: Findings
) {
  const path = yield* Path.Path
  const ids = new Set(batch.items.map((item) => item.id))
  const label = (judge: string) => `${judge}/${batch.batch}.json`
  const read = (judge: string) =>
    judgeRows(
      path.join(dir, "judges", label(judge)),
      label(judge),
      ids,
      findings
    )
  const opus = yield* read("opus")
  const fable = yield* read("fable")
  return batch.items.flatMap((item) => {
    const judged = { opus: opus.get(item.id), fable: fable.get(item.id) }
    return judged.opus === undefined || judged.fable === undefined
      ? []
      : [manifestRow(item, { opus: judged.opus, fable: judged.fable })]
  })
})

const readBatches = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = (yield* fs.readDirectory(path.join(dir, "batches")))
    .filter((name) => name.endsWith(".json"))
    .sort()
  const batches = yield* Effect.forEach(names, (name) =>
    Effect.flatMap(
      fs.readFileString(path.join(dir, "batches", name)),
      Schema.decodeEffect(Batch)
    )
  )
  return { names, batches }
})

// Judge files that answer no batch.
const strayFiles = Effect.fnUntraced(function* (
  dir: string,
  names: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stray = yield* Effect.forEach(judges, (judge) =>
    Effect.orElseSucceed(
      fs.readDirectory(path.join(dir, "judges", judge)),
      () => []
    ).pipe(
      Effect.map((files) =>
        files
          .filter((name) => !names.includes(name))
          .map((name) => `${judge}/${name}: names no batch`)
      )
    )
  )
  return stray.flat()
})

const merge = Effect.fn("merge")(function* (
  root: string,
  args: ReadonlyArray<string>
) {
  const parsed = yield* parseOptions(USAGE, args, {
    dir: { type: "string" },
    manifest: { type: "string" },
  })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = parsed.values.dir ?? (yield* notesDir(false))
  const manifestFile = path.resolve(
    root,
    parsed.values.manifest ?? "scripts/adr-triage/manifest.json"
  )

  const { names, batches } = yield* readBatches(dir)
  const findings: Findings = {
    problems: yield* strayFiles(dir, names),
    long: [],
  }
  const rows = (yield* Effect.forEach(batches, (batch) =>
    joinBatch(dir, batch, findings)
  )).flat()

  for (const warning of findings.long)
    yield* Console.error(`warning: ${warning}`)
  if (findings.problems.length > 0)
    return yield* new CheckFailed({
      summary: `The judges' rows do not cover the batches one to one (${findings.problems.length} problems); no manifest written:`,
      findings: findings.problems,
    })

  const gone = yield* Effect.option(
    Effect.flatMap(
      fs.readFileString(path.join(dir, goneName)),
      Schema.decodeEffect(Gone)
    )
  )
  const [first] = batches
  const manifest = {
    snapshot,
    at: first?.at ?? snapshot,
    since: first?.since ?? null,
    ...(Option.isSome(gone) ? { gone: gone.value } : {}),
    rows,
  }
  yield* fs.makeDirectory(path.dirname(manifestFile), { recursive: true })
  yield* fs.writeFileString(
    manifestFile,
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  yield* Console.log(`Wrote ${rows.length} rows to ${manifestFile}`)
  for (const line of summary(rows)) yield* Console.log(line)
  if (findings.long.length > 0)
    yield* Console.log(`  gists over ${maxGist} chars: ${findings.long.length}`)
})

runScript(
  Effect.gen(function* () {
    const args = yield* (yield* Stdio).args
    return yield* merge(yield* repoRoot, args)
  })
)
