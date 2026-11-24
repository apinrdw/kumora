// The KSEI archive's totals per KSEI report kind, for the admin page (spec
// apinrdw/kumora#327, "The admin page"), from the report index
// (report-index.ts).
import { Effect, Schema } from "effect"

import { KseiReportKind } from "./kind.ts"

const KindTotals = Schema.Struct({
  kind: KseiReportKind,
  // Period ends held, each once.
  reports: Schema.Number,
  // Stored files, each version of a report counted.
  versions: Schema.Number,
  // Every object under the kind's prefix: its files and their records.
  bytes: Schema.Number,
})
type KindTotals = typeof KindTotals.Type

const KseiTotals = Schema.Struct({
  kinds: Schema.Array(KindTotals),
  reports: Schema.Number,
  bytes: Schema.Number,
})
export type KseiTotals = typeof KseiTotals.Type

// From the index's totals of each kind it holds a report of; a kind it
// holds none of is all zeros.
export const kseiTotals = Effect.fnUntraced(function* (
  indexed: ReadonlyArray<KindTotals>
) {
  const kinds = KseiReportKind.literals.map(
    (kind) =>
      indexed.find((row) => row.kind === kind) ?? {
        kind,
        reports: 0,
        versions: 0,
        bytes: 0,
      }
  )
  return KseiTotals.make({
    kinds,
    reports: kinds.reduce((sum, { reports }) => sum + reports, 0),
    bytes: kinds.reduce((sum, { bytes }) => sum + bytes, 0),
  })
})
