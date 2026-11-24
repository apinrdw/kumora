// The cutover import: the first time a run kind is read or claimed while
// ArchiveDb hasn't imported it, its runs are copied from the R2 run records
// written before ArchiveDb held runs. ArchiveDb then marks the kind
// imported, so a later read imports nothing. The R2 records and pointer stay
// in place and are no longer written. Spec apinrdw/kumora#659, "Cutover
// import".
import { Clock, Effect, Option, Schema } from "effect"

import type { Statement } from "../d1.ts"
import { ArchiveDb, type ArchiveDbError } from "./archive-db.ts"
import { ArchiveBucket, type BucketError } from "./bucket.ts"
import { RETENTION_MS } from "./retention.ts"
import {
  type ArchiveSource,
  LatestRun,
  type LatestWhere,
  latestRunKey,
  type RunBase,
  type RunSummaryBase,
  runKey,
} from "./run.ts"
import { RUN_COLUMNS, runRow, type RunKind } from "./run-rows.ts"

// The most records the import holds at once: it reads this many from R2
// at a time and writes them to ArchiveDb in one batch before reading more.
// A record is at most STEP_RESULT_BYTES, which its summary step returns, so
// the import holds at most 10 MiB of records at once.
export const RECORDS_AT_ONCE = 10

const importedStatement = (kind: RunKind): Statement => ({
  sql: "SELECT 1 AS imported FROM run_import WHERE archive = ? AND run_kind = ?",
  params: [kind.archive, kind.runKind],
})

const NOT_IMPORTED =
  "NOT EXISTS (SELECT 1 FROM run_import WHERE archive = ?1 AND run_kind = ?2)"

// What the import reads from the kind's R2 store and writes to ArchiveDb,
// the ids it has written, and the `kept` readers that take one of them.
// Each record goes to ArchiveDb as soon as it is read, so the import never
// holds more than RECORDS_AT_ONCE.
interface Importer<Trigger extends string, RunRecord> {
  readonly imported: ReadonlySet<string>
  readonly found: ReadonlySet<LatestWhere<Trigger, RunRecord>>
  readonly read: (
    key: string
  ) => Effect.Effect<RunRecord | undefined, BucketError>
  // The keys of `trigger`'s records, after `startAfter`, oldest first.
  readonly list: (
    trigger: Trigger,
    startAfter?: string
  ) => Effect.Effect<ReadonlyArray<string>, BucketError>
  readonly write: (
    runs: ReadonlyArray<RunRecord | undefined>
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
    never,
    ArchiveBucket | ArchiveDb
  > {
    const bucket = yield* ArchiveBucket
    const db = yield* ArchiveDb
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(source.result)
    )
    const imported = new Set<string>()
    const found = new Set<LatestWhere<Trigger, RunRecord>>()
    return {
      imported,
      found,
      read: (key: string) =>
        Effect.map(bucket.get(key), (object) =>
          object === undefined
            ? undefined
            : Option.getOrUndefined(decode(object.body))
        ),
      list: (trigger: Trigger, startAfter?: string) =>
        Effect.map(
          bucket.list(
            `${source.runsPrefix}${trigger}-`,
            startAfter === undefined ? {} : { startAfter }
          ),
          (listed) =>
            listed.map(({ key }) => key).filter((key) => key.endsWith(".json"))
        ),
      write: (runs: ReadonlyArray<RunRecord | undefined>) =>
        Effect.gen(function* () {
          const known = runs.filter((run) => run !== undefined)
          if (known.length === 0) return
          yield* db.batch(
            known.map((run): Statement => ({
              sql:
                `INSERT OR IGNORE INTO run (archive, run_kind, ${RUN_COLUMNS}) ` +
                `SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${NOT_IMPORTED}`,
              params: [source.archive, source.runKind, ...runRow(run)],
            }))
          )
          for (const run of known) {
            imported.add(run.id)
            for (const reader of source.kept)
              if (run.trigger === reader.trigger && reader.accept(run))
                found.add(reader)
          }
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
    const read = yield* Effect.forEach(
      recent.slice(start, start + RECORDS_AT_ONCE),
      runs.read,
      { concurrency: "unbounded" }
    )
    yield* runs.write(
      read.filter((run) => run && Date.parse(run.startedAt) >= since)
    )
  }
})

// The id the kind's latest pointer names, and its run, unless written.
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
  if (latest === undefined || runs.imported.has(latest.id)) return latest?.id
  yield* runs.write([
    yield* runs.read(yield* runKey(latest.id, source.runsPrefix)),
  ])
  return latest.id
})

// The newest run `reader` finds, however old, unless a run written already
// is one it takes: older runs hold no newer one. Read one at a time, newest
// first.
const importKept = Effect.fnUntraced(function* <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  runs: Importer<Trigger, RunRecord>,
  reader: LatestWhere<Trigger, RunRecord>
) {
  if (runs.found.has(reader)) return
  for (const key of [...(yield* runs.list(reader.trigger))].reverse()) {
    const id = key.slice(source.runsPrefix.length, -".json".length)
    const run = runs.imported.has(id) ? undefined : yield* runs.read(key)
    if (run !== undefined && reader.accept(run)) return yield* runs.write([run])
  }
})

// Copies the kind's R2 runs into ArchiveDb and marks it imported: the runs
// of the past 30 days, the run its latest pointer names, and the newest run
// each of its `kept` readers finds. Every statement does nothing once an
// import has marked the kind, so an import racing another, or a start's,
// adds no row after the first finishes.
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
    for (const reader of source.kept) yield* importKept(source, runs, reader)

    const kind = [source.archive, source.runKind] as const
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
                "UPDATE run SET latest = 1 WHERE archive = ?1 AND " +
                `run_kind = ?2 AND id = ?3 AND ${NOT_IMPORTED} AND NOT ` +
                "EXISTS (SELECT 1 FROM run WHERE archive = ?1 AND " +
                "run_kind = ?2 AND latest = 1)",
              params: [...kind, latestId],
            },
          ]
    yield* (yield* ArchiveDb).batch([
      ...claim,
      {
        sql: "INSERT OR IGNORE INTO run_import (archive, run_kind) VALUES (?, ?)",
        params: kind,
      },
    ])
    yield* Effect.logInfo(
      `${source.runName}s imported from R2: ${runs.imported.size}`
    )
  })

// A run kind, with its cutover import: what a read of its rows imports
// first, when ArchiveDb hasn't.
export interface ImportedKind<E, R> extends RunKind {
  readonly importRuns: Effect.Effect<void, E, R>
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
// imports those, then reads the statements again in a second batch.
export const readRuns = Effect.fnUntraced(function* <E, R>(
  kinds: ReadonlyArray<ImportedKind<E, R>>,
  statements: ReadonlyArray<Statement>
) {
  const db = yield* ArchiveDb
  const rows = yield* db.batch([...kinds.map(importedStatement), ...statements])
  const missing = kinds.filter((_, index) => (rows[index] ?? []).length === 0)
  if (missing.length === 0) return rows.slice(kinds.length)
  yield* Effect.forEach(missing, (kind) => kind.importRuns, {
    concurrency: "unbounded",
    discard: true,
  })
  return statements.length === 0 ? [] : yield* db.batch(statements)
})

// The kind's cutover import, when it hasn't had one.
export const importedRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) => Effect.asVoid(readRuns([importedKind(source)], []))
