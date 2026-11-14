// The admin page's view of the archive over time: the runs of the past 30
// days and the archive's totals per report kind (spec apinrdw/kumora#303,
// "The admin page").
import { Clock, Effect, Schema } from "effect"

import { ArchiveWorkflow } from "./archive-workflow.ts"
import { ArchiveBucket } from "./bucket.ts"
import { kindPrefix, REPORTS_PREFIX, RUNS_PREFIX } from "./keys.ts"
import { ReportKind } from "./listing.ts"
import { RETENTION_MS } from "./retention.ts"
import { ArchiveTrigger, decodeRunResult, runIdAt } from "./run-result.ts"
import { viewRun } from "./run-view.ts"

// The runs started in the past 30 days, newest first, from runs/<id>.json,
// each shown as the last run card shows it.
// Decision: one listing per trigger, starting after the key of a run that
// trigger would have started 30 days ago. Run ids of one trigger sort as
// their starts do (`runIdAt`), so the page lists and reads only the past 30
// days of runs, and runs/ can grow without the page listing more of it. See
// apinrdw/kumora#310.
export const recentRuns = Effect.gen(function* () {
  const bucket = yield* ArchiveBucket
  const workflow = yield* ArchiveWorkflow
  const now = yield* Clock.currentTimeMillis
  const since = now - RETENTION_MS
  const listings = yield* Effect.forEach(ArchiveTrigger.literals, (trigger) =>
    Effect.gen(function* () {
      const oldest = yield* runIdAt(trigger, since)
      return yield* bucket.list(`${RUNS_PREFIX}${trigger}-`, {
        // runs/<id> sorts just before runs/<id>.json, so that run is listed.
        startAfter: `${RUNS_PREFIX}${oldest}`,
      })
    })
  )
  const records = yield* Effect.forEach(
    listings.flat(),
    ({ key }) => Effect.map(bucket.get(key), (object) => object?.body),
    { concurrency: 10 }
  )
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

const ArchiveTotals = Schema.Struct({
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
