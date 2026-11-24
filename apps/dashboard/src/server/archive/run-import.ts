// The cutover import: the first time a run kind is read or claimed while
// ArchiveDb hasn't imported it, its runs are copied from the R2 run records
// written before ArchiveDb held runs: the run its latest pointer names, the
// runs of the past 30 days, and the newest run each of its `kept` readers
// finds. ArchiveDb then marks the kind imported, so a later read imports
// nothing. The R2 records and pointer stay in place and are no longer
// written. Spec apinrdw/kumora#659, "Cutover import".
import { Clock, Effect, Option, Schema } from "effect"

import type { Statement } from "../d1.ts"
import { ArchiveDb } from "./archive-db.ts"
import { ArchiveBucket } from "./bucket.ts"
import { RETENTION_MS } from "./retention.ts"
import {
  type ArchiveSource,
  LatestRun,
  latestRunKey,
  type RunBase,
  type RunSummaryBase,
  runKey,
} from "./run.ts"
import { RUN_COLUMNS, runRow, type RunKind } from "./run-rows.ts"

// Reads at once when the import gets the records it lists.
const GETS_AT_ONCE = 10

const importedStatement = (kind: RunKind): Statement => ({
  sql: "SELECT 1 AS imported FROM run_import WHERE archive = ? AND run_kind = ?",
  params: [kind.archive, kind.runKind],
})

const NOT_IMPORTED =
  "NOT EXISTS (SELECT 1 FROM run_import WHERE archive = ?1 AND run_kind = ?2)"

// The records the kind's R2 store holds that the import copies, keyed by
// id, and the id its latest pointer names.
const recordsInR2 = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const bucket = yield* ArchiveBucket
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(source.result)
    )
    const records = new Map<string, RunRecord>()
    const read = (key: string) =>
      Effect.map(bucket.get(key), (object) =>
        object === undefined
          ? undefined
          : Option.getOrUndefined(decode(object.body))
      )
    const keep = (run: RunRecord | undefined) => {
      if (run !== undefined) records.set(run.id, run)
      return run
    }

    const pointer = yield* bucket.get(yield* latestRunKey(source.runsPrefix))
    const latest =
      pointer === undefined
        ? undefined
        : Option.getOrUndefined(
            Schema.decodeUnknownOption(Schema.fromJsonString(LatestRun))(
              pointer.body
            )
          )
    if (latest !== undefined)
      keep(yield* read(yield* runKey(latest.id, source.runsPrefix)))

    // Each trigger's runs of the past 30 days, from the key of a run it
    // would have started 30 days ago on: ids of one trigger sort as their
    // starts do.
    const since = (yield* Clock.currentTimeMillis) - RETENTION_MS
    const recentKeys = yield* Effect.forEach(source.triggers, (trigger) =>
      Effect.gen(function* () {
        const oldest = yield* source.runIdAt(trigger, since)
        const listed = yield* bucket.list(`${source.runsPrefix}${trigger}-`, {
          // runs/<id> sorts just before runs/<id>.json, so that run is listed.
          startAfter: `${source.runsPrefix}${oldest}`,
        })
        return listed.map(({ key }) => key)
      })
    )
    yield* Effect.forEach(
      recentKeys.flat().filter((key) => key.endsWith(".json")),
      (key) =>
        Effect.map(read(key), (run) => {
          if (run !== undefined && Date.parse(run.startedAt) >= since) keep(run)
        }),
      { concurrency: GETS_AT_ONCE, discard: true }
    )

    // The newest run each kept reader finds, however old.
    for (const { trigger, accept } of source.kept) {
      const keys = (yield* bucket.list(`${source.runsPrefix}${trigger}-`))
        .map(({ key }) => key)
        .filter((key) => key.endsWith(".json"))
        .reverse()
      for (const key of keys) {
        const known = records.get(key.slice(source.runsPrefix.length, -5))
        const run = known ?? (yield* read(key))
        if (run !== undefined && accept(run)) {
          keep(run)
          break
        }
      }
    }
    return { records: [...records.values()], latestId: latest?.id }
  })

// Rows inserted a batch. A row holds a whole record, which a partial run's
// URLs can grow large, so each is its own statement, as a run writes it.
const ROWS_A_BATCH = 20

// Copies the kind's R2 runs into ArchiveDb and marks it imported. Every
// statement does nothing once an import has marked the kind, so an import
// racing another, or a start's, adds no row after the first finishes.
const importRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) =>
  Effect.gen(function* () {
    const { records, latestId } = yield* recordsInR2(source)
    const kind = [source.archive, source.runKind] as const
    const inserts = records.map((record): Statement => ({
      sql:
        `INSERT OR IGNORE INTO run (archive, run_kind, ${RUN_COLUMNS}) ` +
        `SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${NOT_IMPORTED}`,
      params: [...kind, ...runRow(record)],
    }))
    // The run the pointer names holds the claim, unless a start has claimed
    // since.
    const marks: Array<Statement> = [
      {
        sql: "INSERT OR IGNORE INTO run_import (archive, run_kind) VALUES (?, ?)",
        params: kind,
      },
    ]
    if (latestId !== undefined)
      marks.unshift({
        sql:
          "UPDATE run SET latest = 1 WHERE archive = ?1 AND run_kind = ?2 " +
          `AND id = ?3 AND ${NOT_IMPORTED} AND NOT EXISTS (SELECT 1 FROM run ` +
          "WHERE archive = ?1 AND run_kind = ?2 AND latest = 1)",
        params: [...kind, latestId],
      })
    const db = yield* ArchiveDb
    for (let start = 0; start < inserts.length; start += ROWS_A_BATCH)
      yield* db.batch(inserts.slice(start, start + ROWS_A_BATCH))
    yield* db.batch(marks)
    yield* Effect.logInfo(
      `${source.runName}s imported from R2: ${records.length}`
    )
  })

// Each statement's rows, read in one ArchiveDb batch, after the kind's
// cutover import when it hasn't had one. Statements of other kinds may ride
// along, once each of their kinds has been imported too.
export const readRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>,
  statements: ReadonlyArray<Statement>
) =>
  Effect.gen(function* () {
    const db = yield* ArchiveDb
    const [imported = [], ...rows] = yield* db.batch([
      importedStatement(source),
      ...statements,
    ])
    if (imported.length > 0) return rows
    yield* importRuns(source)
    return statements.length === 0 ? [] : yield* db.batch(statements)
  })

// The kind's cutover import, when it hasn't had one.
export const importedRuns = <
  Trigger extends string,
  Summary extends RunSummaryBase,
  RunRecord extends RunBase & Summary,
>(
  source: ArchiveSource<Trigger, Summary, RunRecord>
) => Effect.asVoid(readRuns(source, []))
