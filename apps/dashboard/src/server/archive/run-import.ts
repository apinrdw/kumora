// The cutover import: the first time a run kind is read or claimed while
// ArchiveDb hasn't imported it, its runs are copied from the R2 run records
// written before ArchiveDb held runs. ArchiveDb then marks the kind
// imported, so a later read imports nothing. The R2 records and pointer stay
// in place and are no longer written. Spec apinrdw/kumora#659, "Cutover
// import".
//
// An import is scans of the kind's R2 records, each with a purpose of its
// own:
//
//   window   a trigger's runs of the past 30 days
//   latest   the run the kind's latest pointer names
//   reader   the newest run a trigger's reader past retention takes
//
// A scan is built from its own progress and writes only its own, so a
// record one scan passes over is still there for another to read. All that
// scans share is a run's row, which every one of them wants.
//
// `importedKind`, the scans and their statements are plain functions, not
// Effects, as reportIndexOf (report-index.ts) is: they only build a page
// part's kinds (page-read.ts) and a scan's keys and decisions, which are
// the Effects, and the data an import writes.
import { Array as Arr, Clock, Effect, Option, Schema } from "effect"

import type { Statement } from "../d1.ts"
import { ArchiveDb, type ArchiveDbError } from "./archive-db.ts"
import { ArchiveBucket, type BucketError } from "./bucket.ts"
import { RETENTION_MS } from "./retention.ts"
import {
  type ArchiveSource,
  LatestRun,
  latestRunKey,
  type RunBase,
  type RunId,
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

// The most batches of RECORDS_AT_ONCE that one Worker invocation's import
// of a kind reads and writes. An import with more to read stops there, and
// the next invocation resumes it. The two keep an invocation's calls to D1
// and R2 within the limits the ADR names, whatever R2 holds.
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

// A record the import read from R2 at `key`: its run, or undefined for one
// that has gone, no longer decodes or holds another run's id, which no scan
// keeps.
interface Read<RunRecord> {
  readonly key: string
  readonly run: RunRecord | undefined
}

// What a scan makes of the records it read: the runs to keep as rows, its
// progress past every one of them, and whether it needs no more.
interface Decided<RunRecord> {
  readonly keep: ReadonlyArray<RunRecord>
  readonly progress: ReadonlyArray<Statement>
  readonly ended: boolean
}

// One scan of a kind's R2 run records: the keys it has yet to read, in the
// batches it reads them in, each of at most RECORDS_AT_ONCE, and what it
// makes of a batch's records. The import writes each decision in one
// ArchiveDb batch, so a scan's progress and the rows it kept on the way
// there go in together.
interface Scan<RunRecord> {
  readonly batches: Effect.Effect<
    ReadonlyArray<ReadonlyArray<string>>,
    BucketError | ArchiveDbError,
    ArchiveBucket | ArchiveDb
  >
  readonly decide: (
    read: ReadonlyArray<Read<RunRecord>>
  ) => Effect.Effect<Decided<RunRecord>>
}

const runsOf = <RunRecord>(read: ReadonlyArray<Read<RunRecord>>) =>
  read.flatMap(({ run }) => (run === undefined ? [] : [run]))

// `trigger`'s record keys after `startAfter`, oldest first.
const listKeys = Effect.fnUntraced(function* (
  source: { readonly runsPrefix: string },
  trigger: string,
  startAfter?: string
) {
  const listed = yield* (yield* ArchiveBucket).list(
    `${source.runsPrefix}${trigger}-`,
    startAfter === undefined ? {} : { startAfter }
  )
  return listed.map(({ key }) => key).filter((key) => key.endsWith(".json"))
})

// Where each scan of an unfinished import of the kind stopped
// (archive-migrations/0004_run_import_scans.sql), by trigger. A row is
// one scan's: `windowScan` and `readerScan` each get their own and no
// other.
const progressStatements = (kind: ArchiveRunKind): ReadonlyArray<Statement> => [
  {
    sql: `SELECT trigger, after_key FROM run_import_window WHERE ${OF_KIND}`,
    params: kindParams(kind),
  },
  {
    sql:
      "SELECT trigger, before_key, found FROM run_import_reader " +
      `WHERE ${OF_KIND}`,
    params: kindParams(kind),
  },
]

// A scan's progress only moves on: an invocation that writes after a
// faster one, from where both began, moves it nowhere.
const windowProgress = (
  kind: ArchiveRunKind,
  trigger: string,
  after: string
): Statement => ({
  sql:
    "INSERT INTO run_import_window (archive, run_kind, trigger, after_key) " +
    `SELECT ?1, ?2, ?3, ?4 WHERE ${NOT_IMPORTED} ` +
    "ON CONFLICT (archive, run_kind, trigger) DO UPDATE SET " +
    "after_key = max(after_key, excluded.after_key)",
  params: [...kindParams(kind), trigger, after],
})

const readerProgress = (
  kind: ArchiveRunKind,
  trigger: string,
  before: string,
  found: boolean
): Statement => ({
  sql:
    "INSERT INTO run_import_reader " +
    "(archive, run_kind, trigger, before_key, found) " +
    `SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${NOT_IMPORTED} ` +
    "ON CONFLICT (archive, run_kind, trigger) DO UPDATE SET " +
    "before_key = min(before_key, excluded.before_key), " +
    "found = max(found, excluded.found)",
  params: [...kindParams(kind), trigger, before, found ? 1 : 0],
})

// A trigger's window scan: its records from the key of a run it would have
// started at `since` on, oldest first, resumed after the key `after`. It
// keeps every run it reads, by its key alone: the start a record gives
// decides nothing here, so the scan passes over no run that another purpose
// could need. A read of the past 30 days filters by start itself
// (recentRunsStatement, run-rows.ts).
const windowScan = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  trigger: Trigger,
  since: number,
  after: string | undefined
): Scan<RunRecord> => ({
  batches: Effect.gen(function* () {
    // runs/<id> sorts just before runs/<id>.json, so that run is listed.
    const oldest = `${source.runsPrefix}${yield* source.runIdAt(trigger, since)}`
    const keys = yield* listKeys(
      source,
      trigger,
      after !== undefined && after > oldest ? after : oldest
    )
    return Arr.chunksOf(keys, RECORDS_AT_ONCE)
  }),
  decide: (read) => {
    const last = read.at(-1)
    return Effect.succeed({
      keep: runsOf(read),
      progress:
        last === undefined ? [] : [windowProgress(source, trigger, last.key)],
      ended: false,
    })
  },
})

// The latest scan: the record of the run the kind's latest pointer names,
// `id`, however old, unless ArchiveDb holds its row by the time the scan
// runs. It keeps no progress: the row is its mark.
const latestScan = <RunRecord>(
  source: ArchiveRunKind & { readonly runsPrefix: string },
  id: RunId | undefined
): Scan<RunRecord> => ({
  batches: Effect.gen(function* () {
    if (id === undefined) return []
    const [held = []] = yield* (yield* ArchiveDb).batch([
      {
        sql: `SELECT 1 AS held FROM run WHERE ${OF_KIND} AND id = ?3`,
        params: [...kindParams(source), id],
      },
    ])
    return held.length > 0 ? [] : [[yield* runKey(id, source.runsPrefix)]]
  }),
  decide: (read) =>
    Effect.succeed({ keep: runsOf(read), progress: [], ended: false }),
})

// Where a trigger's reader scan stopped.
interface ReaderProgress {
  readonly before: string
  readonly found: boolean
}

// A trigger's reader scan: its records however old, newest first, resumed
// before the key in `progress`, until one holds a run its reader past
// retention takes, `accept`, which it keeps. It reads the trigger's newest
// records whatever the window scan made of them, so neither depends on
// where the other's 30 days began. It reads the newest alone first: a
// reader most often takes that one, and then reads no older record.
const readerScan = <RunRecord>(
  source: ArchiveRunKind & { readonly runsPrefix: string },
  trigger: string,
  accept: (run: RunRecord) => boolean,
  progress: ReaderProgress | undefined
): Scan<RunRecord> => ({
  batches:
    progress?.found === true
      ? Effect.succeed([])
      : Effect.map(listKeys(source, trigger), (keys) => {
          const [newest, ...older] = keys
            .filter((key) => progress === undefined || key < progress.before)
            .reverse()
          return newest === undefined
            ? []
            : [[newest], ...Arr.chunksOf(older, RECORDS_AT_ONCE)]
        }),
  decide: (read) =>
    Effect.sync(() => {
      const taken = read.findIndex(
        ({ run }) => run !== undefined && accept(run)
      )
      const found = taken >= 0
      // The records newer than the one taken, and it: the last it read.
      const decided = found ? read.slice(0, taken + 1) : read
      const last = decided.at(-1)
      return {
        keep: found ? runsOf(decided.slice(-1)) : [],
        progress:
          last === undefined
            ? []
            : [readerProgress(source, trigger, last.key, found)],
        ended: found,
      }
    }),
})

// The id the kind's latest pointer names: undefined with no pointer, or one
// that doesn't decode.
const pointedId = Effect.fnUntraced(function* (source: {
  readonly runsPrefix: string
}) {
  const pointer = yield* (yield* ArchiveBucket).get(
    yield* latestRunKey(source.runsPrefix)
  )
  if (pointer === undefined) return undefined
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(LatestRun))(pointer.body)
  )?.id
})

// Copies the kind's R2 runs into ArchiveDb and marks it imported, by its
// scans in turn: each trigger's window scan, the latest scan, then each
// reader scan. It stops at IMPORT_BATCHES with more to read, and says
// whether it finished: the next import resumes each scan from the progress
// this one wrote. Every statement does nothing once an import has marked
// the kind, so an import racing another, or a start's, adds no row after
// the first finishes. What it must keep true is in the ADR.
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
    const bucket = yield* ArchiveBucket
    const db = yield* ArchiveDb
    const kind = kindParams(source)
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(source.result)
    )
    const latestId = yield* pointedId(source)
    const [windows = [], readers = []] = yield* db.batch(
      progressStatements(source)
    )
    const windowAfter = new Map(
      windows.map((row) => [String(row["trigger"]), String(row["after_key"])])
    )
    const readerAt = new Map(
      readers.map((row): [string, ReaderProgress] => [
        String(row["trigger"]),
        { before: String(row["before_key"]), found: row["found"] === 1 },
      ])
    )
    const since = (yield* Clock.currentTimeMillis) - RETENTION_MS
    const scans: ReadonlyArray<Scan<RunRecord>> = [
      ...source.triggers.map((trigger) =>
        windowScan(source, trigger, since, windowAfter.get(trigger))
      ),
      latestScan(source, latestId),
      ...source.triggers.flatMap((trigger) => {
        const accept = source.readersPastRetention[trigger]
        return accept === undefined
          ? []
          : [readerScan(source, trigger, accept, readerAt.get(trigger))]
      }),
    ]

    const idOf = (key: string) =>
      key.slice(source.runsPrefix.length, -".json".length)
    let batches = 0
    let read = 0
    for (const scan of scans) {
      for (const keys of yield* scan.batches) {
        if (batches === IMPORT_BATCHES) {
          yield* Effect.logInfo(
            `${source.runName}s read from R2, with more to read: ${read}`
          )
          return false
        }
        batches += 1
        const records = yield* Effect.forEach(
          keys,
          (key) =>
            Effect.map(bucket.get(key), (object): Read<RunRecord> => {
              const run =
                object === undefined
                  ? undefined
                  : Option.getOrUndefined(decode(object.body))
              // A record under another run's key is no run of this key: its
              // row, keyed by the id it holds, would stand in for that
              // run's own record.
              return { key, run: run?.id === idOf(key) ? run : undefined }
            }),
          { concurrency: "unbounded" }
        )
        read += records.length
        const decided = yield* scan.decide(records)
        const statements = [
          ...decided.keep.map((run): Statement => ({
            sql:
              `INSERT OR IGNORE INTO run (archive, run_kind, ${RUN_COLUMNS}) ` +
              `SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${NOT_IMPORTED}`,
            params: [...kind, ...runRow(run)],
          })),
          ...decided.progress,
        ]
        if (statements.length > 0) yield* db.batch(statements)
        if (decided.ended) break
      }
    }

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
    yield* db.batch([
      ...claim,
      {
        sql: "INSERT OR IGNORE INTO run_import (archive, run_kind) VALUES (?1, ?2)",
        params: kind,
      },
      ...["run_import_window", "run_import_reader"].map((table) => ({
        sql: `DELETE FROM ${table} WHERE ${OF_KIND}`,
        params: kind,
      })),
    ])
    yield* Effect.logInfo(`${source.runName}s read from R2: ${read}`)
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
