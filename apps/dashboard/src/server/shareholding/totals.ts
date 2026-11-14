// The shareholding archive's totals per report kind, for the admin page
// (spec apinrdw/kumora#303, "The admin page").
import { Effect, Schema } from "effect"

import { ArchiveBucket } from "../archive/bucket.ts"
import { REPORTS_PREFIX } from "../archive/run.ts"
import { kindPrefix } from "./keys.ts"
import { ReportKind } from "./listing.ts"

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
// and their records on 2026-11-14, plus ~50 objects a month (~24 files,
// docs/research/idx-kepemilikan-listing.md), a few hundred KB of keys, held
// only for the count. See apinrdw/kumora#303 and #310.
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
