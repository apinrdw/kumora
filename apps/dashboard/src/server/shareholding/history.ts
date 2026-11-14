// The admin page's view of the archive over time: the runs of the past 30
// days and the archive's totals per report kind (spec apinrdw/kumora#303,
// "The admin page").
import { Clock, Effect, Schema } from "effect"

import { ArchiveBucket } from "./bucket.ts"
import { LATEST_RUN_KEY, REPORTS_PREFIX } from "./keys.ts"
import { ReportKind } from "./listing.ts"
import { ArchiveRunResult } from "./run-result.ts"
import { RETENTION_MS } from "./start-run.ts"

const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ArchiveRunResult)
)

// The runs started in the past 30 days, newest first, from runs/<id>.json.
// Decision: a record R2 last wrote before the 30 days is never read. Each
// run rewrites its record when it ends, so that write is no earlier than its
// start; the listing alone rules out the old runs, and the page reads at
// most 30 days of records however long the archive has run.
export const recentRuns = Effect.gen(function* () {
  const bucket = yield* ArchiveBucket
  const since = (yield* Clock.currentTimeMillis) - RETENTION_MS
  const keys = (yield* bucket.list("runs/"))
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
    (record) => decodeResult(record)
  )
  return runs
    .filter((run) => Date.parse(run.startedAt) >= since)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
})

export interface ArchiveTotals {
  // Every report kind, in the listing's order, with its stored files.
  readonly kinds: ReadonlyArray<{
    readonly kind: ReportKind
    readonly reports: number
  }>
  readonly reports: number
  // Every object under reports/: the files and their records.
  readonly bytes: number
}

// One listing of reports/. A report counts once per stored file, so each
// version of it counts.
export const archiveTotals = Effect.gen(function* () {
  const objects = yield* (yield* ArchiveBucket).list(REPORTS_PREFIX)
  const files = objects.filter(({ key }) => key.endsWith(".xlsx"))
  const kinds = ReportKind.literals.map((kind) => ({
    kind,
    reports: files.filter(({ key }) =>
      key.startsWith(`${REPORTS_PREFIX}${kind}/`)
    ).length,
  }))
  return {
    kinds,
    reports: files.length,
    bytes: objects.reduce((sum, { size }) => sum + size, 0),
  } satisfies ArchiveTotals
})
