// The cutover import: the first time a run kind is read or claimed while
// ArchiveDb hasn't imported it, its runs are copied from the R2 run records
// written before ArchiveDb held runs. ArchiveDb then marks the kind
// imported, so a later read imports nothing. The R2 records and pointer stay
// in place and are no longer written. Spec apinrdw/kumora#659, "Cutover
// import". `importedKind`, its statements and `passedOver` are plain
// functions, not Effects, as reportIndexOf (report-index.ts) is: they only
// build a page part's kinds (page-read.ts), whose `importRuns` is the
// Effect, and the data it writes.
import { Clock, Effect, Option, Schema } from "effect"

import type { Statement } from "../d1.ts"
import { ArchiveDb, type ArchiveDbError } from "./archive-db.ts"
import { ArchiveBucket, type BucketError } from "./bucket.ts"
import { RETENTION_MS } from "./retention.ts"
import {
  type ArchiveSource,
  LatestRun,
  latestRunKey,
  type RunBase,
  type RunSummaryBase,
  runKey,
} from "./run.ts"
import {
  type ArchiveRunKind,
  kindParams,
  OF_KIND,
  RUN_COLUMNS,
  runRow,
} from "./run-rows.ts"

// The most records the import holds at once: it reads this many from R2
// at a time and writes them to ArchiveDb in one batch before reading more.
// A record is at most STEP_RESULT_BYTES, which its summary step returns, so
// the import holds at most 10 MiB of records at once.
export const RECORDS_AT_ONCE = 10

// The most batches of records one Worker invocation's import of a kind
// writes, so its calls stay within an invocation's limits whatever R2
// holds: 1,000 D1 queries, a batch each, and 10,000 subrequests, every D1
// and R2 call. An import with more to do stops there, and the next
// invocation resumes it.
// Decision: ArchiveDb is the source of truth for runs
// (apps/dashboard/docs/adr/0128-archivedb-is-the-source-of-truth-for-runs.md)
export const IMPORT_BATCHES = 20

// The import of `kinds` stopped at IMPORT_BATCHES with more to do: their
// runs are not all in ArchiveDb yet, and the next read or start of them
// imports more.
export class RunsImporting extends Schema.TaggedError<RunsImporting>()(
  "RunsImporting",
  { kinds: Schema.Array(Schema.String) }
) {}

const importedStatement = (kind: ArchiveRunKind): Statement => ({
  sql: `SELECT 1 AS imported FROM run_import WHERE ${OF_KIND}`,
  params: kindParams(kind),
})

const NOT_IMPORTED = `NOT EXISTS (SELECT 1 FROM run_import WHERE ${OF_KIND})`

// What an unfinished import before this one did
// (archive-migrations/0003_run_import_progress.sql): the run ids it read,
// its rows' and those it passed over, as `id`, and the triggers whose
// reader past retention found its run, as `trigger`.
const progressStatements = (kind: ArchiveRunKind): ReadonlyArray<Statement> => [
  {
    sql:
      `SELECT id FROM run WHERE ${OF_KIND} ` +
      `UNION ALL SELECT id FROM run_import_passed WHERE ${OF_KIND}`,
    params: kindParams(kind),
  },
  {
    sql: `SELECT trigger FROM run_import_found WHERE ${OF_KIND}`,
    params: kindParams(kind),
  },
]

// A record the import read from R2, by the run id its key names: its run,
// to keep as a row, or undefined, to pass over.
interface Read<RunRecord> {
  readonly id: string
  readonly run: RunRecord | undefined
}

const passedOver = <RunRecord>({ id }: Read<RunRecord>): Read<RunRecord> => ({
  id,
  run: undefined,
})

// What the kind's import has read from R2 and written to ArchiveDb, in this
// invocation and any before, and how it reads and writes more. Each record
// goes to ArchiveDb as soon as it is read, so the import never holds more
// than RECORDS_AT_ONCE, and none is read again.
interface Importer<Trigger extends string, RunRecord> {
  // The run ids it has read.
  readonly done: ReadonlySet<string>
  // The triggers whose reader past retention has found its run.
  readonly found: ReadonlySet<string>
  // Whether this invocation's import stopped at IMPORT_BATCHES.
  readonly stopped: () => boolean
  // The keys of `trigger`'s records after `startAfter` whose runs the import
  // hasn't read, oldest first.
  readonly list: (
    trigger: Trigger,
    startAfter?: string
  ) => Effect.Effect<ReadonlyArray<string>, BucketError>
  // The records at `keys`, at most RECORDS_AT_ONCE, read at once: undefined,
  // with none read, once this invocation has written IMPORT_BATCHES.
  readonly read: (
    keys: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Read<RunRecord>> | undefined, BucketError>
  // Writes `reads` in one batch: each run as its row, the rest as passed
  // over, and each reader past retention one of the runs takes as found.
  readonly write: (
    reads: ReadonlyArray<Read<RunRecord>>
  ) => Effect.Effect<void, ArchiveDbError>
}

const importer = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* (): Effect.fn.Return<
    Importer<Trigger, RunRecord>,
    ArchiveDbError,
    ArchiveBucket | ArchiveDb
  > {
    const bucket = yield* ArchiveBucket
    const db = yield* ArchiveDb
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(source.result)
    )
    const kind = kindParams(source)
    const [ids = [], triggers = []] = yield* db.batch(
      progressStatements(source)
    )
    const done = new Set(ids.map(({ id }) => String(id)))
    const found = new Set(triggers.map(({ trigger }) => String(trigger)))
    const idOf = (key: string) =>
      key.slice(source.runsPrefix.length, -".json".length)
    let batches = 0
    let stopped = false
    const insert = (table: string, column: string, value: string) => ({
      sql:
        `INSERT OR IGNORE INTO ${table} (archive, run_kind, ${column}) ` +
        `SELECT ?1, ?2, ?3 WHERE ${NOT_IMPORTED}`,
      params: [...kind, value],
    })
    return {
      done,
      found,
      stopped: () => stopped,
      list: (trigger: Trigger, startAfter?: string) =>
        Effect.map(
          bucket.list(
            `${source.runsPrefix}${trigger}-`,
            startAfter === undefined ? {} : { startAfter }
          ),
          (listed) =>
            listed
              .map(({ key }) => key)
              .filter((key) => key.endsWith(".json") && !done.has(idOf(key)))
        ),
      read: (keys: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          stopped ||= batches >= IMPORT_BATCHES
          if (stopped) return undefined
          batches += 1
          return yield* Effect.forEach(
            keys,
            (key) =>
              Effect.map(bucket.get(key), (object): Read<RunRecord> => {
                const id = idOf(key)
                const run =
                  object === undefined
                    ? undefined
                    : Option.getOrUndefined(decode(object.body))
                // A record under another run's key is passed over: its row
                // would never mark the key read.
                return { id, run: run?.id === id ? run : undefined }
              }),
            { concurrency: "unbounded" }
          )
        }),
      write: (reads: ReadonlyArray<Read<RunRecord>>) =>
        Effect.gen(function* () {
          if (reads.length === 0) return
          const runs = reads.flatMap(({ run }) =>
            run === undefined ? [] : [run]
          )
          const taken = source.triggers.filter((trigger) => {
            const accept = source.readersPastRetention[trigger]
            return (
              accept !== undefined &&
              !found.has(trigger) &&
              runs.some((run) => run.trigger === trigger && accept(run))
            )
          })
          yield* db.batch([
            ...reads.map(({ id, run }): Statement =>
              run === undefined
                ? insert("run_import_passed", "id", id)
                : {
                    sql:
                      `INSERT OR IGNORE INTO run (archive, run_kind, ${RUN_COLUMNS}) ` +
                      `SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${NOT_IMPORTED}`,
                    params: [...kind, ...runRow(run)],
                  }
            ),
            ...taken.map((trigger) =>
              insert("run_import_found", "trigger", trigger)
            ),
          ])
          for (const { id } of reads) done.add(id)
          for (const trigger of taken) found.add(trigger)
        }),
    }
  })

// Each trigger's runs of the past 30 days, from the key of a run it would
// have started 30 days ago on: ids of one trigger sort as their starts do.
const importRecent = Effect.fnUntraced(function* <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  runs: Importer<Trigger, RunRecord>
) {
  const since = (yield* Clock.currentTimeMillis) - RETENTION_MS
  const keys = yield* Effect.forEach(source.triggers, (trigger) =>
    Effect.flatMap(source.runIdAt(trigger, since), (oldest) =>
      // runs/<id> sorts just before runs/<id>.json, so that run is listed.
      runs.list(trigger, `${source.runsPrefix}${oldest}`)
    )
  )
  const recent = keys.flat()
  for (let start = 0; start < recent.length; start += RECORDS_AT_ONCE) {
    const read = yield* runs.read(recent.slice(start, start + RECORDS_AT_ONCE))
    if (read === undefined) return
    yield* runs.write(
      read.map((each) =>
        each.run !== undefined && Date.parse(each.run.startedAt) >= since
          ? each
          : passedOver(each)
      )
    )
  }
})

// The id the kind's latest pointer names, and its run, unless read.
const importLatest = Effect.fnUntraced(function* <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  runs: Importer<Trigger, RunRecord>
) {
  const pointer = yield* (yield* ArchiveBucket).get(
    yield* latestRunKey(source.runsPrefix)
  )
  if (pointer === undefined) return undefined
  const latest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(LatestRun))(pointer.body)
  )
  if (latest === undefined || runs.done.has(latest.id)) return latest?.id
  const read = yield* runs.read([yield* runKey(latest.id, source.runsPrefix)])
  if (read !== undefined) yield* runs.write(read)
  return latest.id
})

// The newest run `trigger`'s reader takes, however old, unless a run
// imported already is one it takes: older runs hold no newer one. Read
// RECORDS_AT_ONCE at a time, newest first; the runs newer than the one it
// takes are passed over.
const importKept = Effect.fnUntraced(function* <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  runs: Importer<Trigger, RunRecord>,
  trigger: Trigger,
  accept: (run: RunRecord) => boolean
) {
  if (runs.found.has(trigger)) return
  const keys = [...(yield* runs.list(trigger))].reverse()
  for (let start = 0; start < keys.length; start += RECORDS_AT_ONCE) {
    const read = yield* runs.read(keys.slice(start, start + RECORDS_AT_ONCE))
    if (read === undefined) return
    const taken = read.findIndex(({ run }) => run !== undefined && accept(run))
    if (taken < 0) yield* runs.write(read.map(passedOver))
    else
      return yield* runs.write([
        ...read.slice(0, taken).map(passedOver),
        ...read.slice(taken, taken + 1),
      ])
  }
})

// Copies the kind's R2 runs into ArchiveDb and marks it imported: the runs
// of the past 30 days, the run its latest pointer names, and the newest run
// each of its readers past retention finds. It stops at IMPORT_BATCHES with
// more to do, and says whether it finished: the next import resumes from
// what this one wrote. Every statement does nothing once an import has
// marked the kind, so an import racing another, or a start's, adds no row
// after the first finishes.
// Decision: ArchiveDb is the source of truth for runs
// (apps/dashboard/docs/adr/0128-archivedb-is-the-source-of-truth-for-runs.md)
const importRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const runs = yield* importer(source)
    yield* importRecent(source, runs)
    const latestId = yield* importLatest(source, runs)
    for (const trigger of source.triggers) {
      const accept = source.readersPastRetention[trigger]
      if (accept !== undefined) yield* importKept(runs, trigger, accept)
    }
    if (runs.stopped()) {
      yield* Effect.logInfo(
        `${source.runName}s read from R2 so far: ${runs.done.size}`
      )
      return false
    }

    const kind = kindParams(source)
    // The run the pointer names holds the claim, unless a start has claimed
    // since.
    // Decision: the latest run row is the one claim on a run
    // (apps/dashboard/docs/adr/0127-the-latest-run-row-is-the-one-claim-on-a-run.md)
    const claim: ReadonlyArray<Statement> =
      latestId === undefined
        ? []
        : [
            {
              sql:
                `UPDATE run SET latest = 1 WHERE ${OF_KIND} AND id = ?3 ` +
                `AND ${NOT_IMPORTED} AND NOT EXISTS (SELECT 1 FROM run ` +
                `WHERE ${OF_KIND} AND latest = 1)`,
              params: [...kind, latestId],
            },
          ]
    yield* (yield* ArchiveDb).batch([
      ...claim,
      {
        sql: "INSERT OR IGNORE INTO run_import (archive, run_kind) VALUES (?1, ?2)",
        params: kind,
      },
      ...["run_import_passed", "run_import_found"].map((table) => ({
        sql: `DELETE FROM ${table} WHERE ${OF_KIND}`,
        params: kind,
      })),
    ])
    yield* Effect.logInfo(`${source.runName}s read from R2: ${runs.done.size}`)
    return true
  })

// A run kind, with its cutover import: what a read of its rows imports
// first, when ArchiveDb hasn't. The import says whether it finished.
export interface ImportedKind<E, R> extends ArchiveRunKind {
  readonly importRuns: Effect.Effect<boolean, E, R>
}

export const importedKind = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) => ({
  archive: source.archive,
  runKind: source.runKind,
  importRuns: importRuns(source),
})

// Each statement's rows, read in one ArchiveDb batch beside a check of
// whether each of `kinds` has been imported. Should any not have been, it
// imports those, then reads the statements again in a second batch. It
// fails with RunsImporting while any import is unfinished, so no reader
// sees part of a kind's runs as all of them.
export const readRuns = Effect.fnUntraced(function* <E, R>(
  given: ReadonlyArray<ImportedKind<E, R>>,
  statements: ReadonlyArray<Statement>
) {
  const kinds = [
    ...new Map(
      given.map((kind) => [`${kind.archive}/${kind.runKind}`, kind])
    ).values(),
  ]
  const db = yield* ArchiveDb
  const rows = yield* db.batch([...kinds.map(importedStatement), ...statements])
  const missing = kinds.filter((_, index) => (rows[index] ?? []).length === 0)
  if (missing.length === 0) return rows.slice(kinds.length)
  const finished = yield* Effect.forEach(missing, (kind) => kind.importRuns, {
    concurrency: "unbounded",
  })
  const unfinished = missing.filter((_, index) => !finished[index])
  if (unfinished.length > 0)
    return yield* new RunsImporting({
      kinds: unfinished.map((kind) => `${kind.archive}/${kind.runKind}`),
    })
  return statements.length === 0 ? [] : yield* db.batch(statements)
})

// Runs the kind's cutover import, unless it has had one: RunsImporting
// while it is unfinished.
export const importOnce = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) => Effect.asVoid(readRuns([importedKind(source)], []))
