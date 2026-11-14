// The KSEI archive's totals per KSEI report kind, for the admin page (spec
// apinrdw/kumora#327, "The admin page").
import { Effect, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import { REPORTS_PREFIX } from "../archive/run.ts"
import { kindPrefix } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"

const KseiTotals = Schema.Struct({
  kinds: Schema.Array(
    Schema.Struct({
      kind: KseiReportKind,
      // Period ends held, each once.
      reports: Schema.Number,
      // Stored files, each version of a report counted.
      versions: Schema.Number,
      // Every object under the kind's prefix: its files and their records.
      bytes: Schema.Number,
    })
  ),
  reports: Schema.Number,
  bytes: Schema.Number,
})
export type KseiTotals = typeof KseiTotals.Type

// One listing of reports/: ~150 objects after the first run, ~1,000 after a
// deep backfill, far within MAX_LISTED_OBJECTS.
export const kseiTotals = Effect.gen(function* () {
  const objects = yield* (yield* ArchiveBucket).list(REPORTS_PREFIX)
  const kinds = yield* Effect.forEach(KseiReportKind.literals, (kind) =>
    Effect.map(kindPrefix(kind), (prefix) => {
      const under = objects.filter(({ key }) => key.startsWith(prefix))
      const zips = under.filter(({ key }) => key.endsWith(".zip"))
      return {
        kind,
        // reports/<kind>/<period-end>/<sha256>.zip
        reports: new Set(zips.map(({ key }) => key.split("/")[2])).size,
        versions: zips.length,
        bytes: under.reduce((sum, { size }) => sum + size, 0),
      }
    })
  )
  return KseiTotals.make({
    kinds,
    reports: kinds.reduce((sum, { reports }) => sum + reports, 0),
    bytes: kinds.reduce((sum, { bytes }) => sum + bytes, 0),
  })
})
