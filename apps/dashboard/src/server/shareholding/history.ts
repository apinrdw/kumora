// The admin page's view of the archive over time: the runs of the past 30
// days and the archive's totals per report kind (spec apinrdw/kumora#303,
// "The admin page").
import { Clock, Effect, Schema } from "effect"

import { ArchiveWorkflow } from "./archive-workflow.ts"
import { ArchiveBucket } from "./bucket.ts"
import {
  kindPrefix,
  LATEST_RUN_KEY,
  REPORTS_PREFIX,
  RUNS_PREFIX,
} from "./keys.ts"
import { ReportKind } from "./listing.ts"
import { RETENTION_MS } from "./retention.ts"
import { decodeRunResult } from "./run-result.ts"
import { viewRun } from "./run-view.ts"

// The runs started in the past 30 days, newest first, from runs/<id>.json,
// each shown as the last run card shows it.
// Decision: a record R2 last wrote before the 30 days is never read. Each
// run rewrites its record when it ends, so that write is no earlier than its
// start: the listing alone rules out old runs, so the page reads at most 30
// days of records. The key listing itself grows by ~2 keys a day, about 730
// a year of 0.1 KB entries, and stays one paged list. See apinrdw/kumora#310.
export const recentRuns = Effect.gen(function* () {
  const bucket = yield* ArchiveBucket
  const workflow = yield* ArchiveWorkflow
  const now = yield* Clock.currentTimeMillis
  const since = now - RETENTION_MS
  const keys = (yield* bucket.list(RUNS_PREFIX))
    .filter(
      ({ key, uploaded }) =>
        key !== LATEST_RUN_KEY && uploaded.getTime() >= since
    )
    .map(({ key }) => key)
  const records = yield* Effect.forEach(keys, (key) => bucket.get(key), {
    concurrency: 10,
  })
  const runs = yield* Effect.forEach(
    records.filter((record) => record !== undefined),
    (record) => decodeRunResult(record)
  )
  const recent = runs
    .filter((run) => Date.parse(run.startedAt) >= since)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  // Only a record that still says running needs its instance's status.
  return yield* Effect.forEach(
    recent,
    (run) =>
      Effect.gen(function* () {
        const instance =
          run.outcome === "running" ? yield* workflow.status(run.id) : undefined
        return (yield* viewRun(run, instance, now)).result
      }),
    { concurrency: 10 }
  )
})

export const ArchiveTotals = Schema.Struct({
  // Every report kind, in the listing's order, with its stored files.
  kinds: Schema.Array(
    Schema.Struct({ kind: ReportKind, reports: Schema.Number })
  ),
  reports: Schema.Number,
  // Every object under reports/: the files and their records.
  bytes: Schema.Number,
})
export type ArchiveTotals = typeof ArchiveTotals.Type

// One listing of reports/. A report counts once per stored file, so each
// version of it counts.
// Decision: the totals list every object under reports/, as the spec asks
// ("one bucket listing of reports/ with custom metadata"): about 150 files
// and their records, plus ~2 a day, a few hundred KB of keys, held only for
// the count. See apinrdw/kumora#303 and #310.
export const archiveTotals = Effect.gen(function* () {
  const objects = yield* (yield* ArchiveBucket).list(REPORTS_PREFIX)
  const files = objects.filter(({ key }) => key.endsWith(".xlsx"))
  const kinds = yield* Effect.forEach(ReportKind.literals, (kind) =>
    Effect.map(kindPrefix(kind), (prefix) => ({
      kind,
      reports: files.filter(({ key }) => key.startsWith(prefix)).length,
    }))
  )
  return ArchiveTotals.make({
    kinds,
    reports: files.length,
    bytes: objects.reduce((sum, { size }) => sum + size, 0),
  })
})
