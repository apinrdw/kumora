// The shareholding archive's totals per report kind, for the admin page
// (spec apinrdw/kumora#303, "The admin page"), from the report index
// (report-index.ts), as a part of the admin page's ArchiveDb batch.
import { Effect, Schema } from "effect"

import { mapRead } from "../archive/page-read.ts"
import { ReportKind } from "./listing.ts"
import { shareholdingIndex } from "./report-index.ts"

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

// A report counts once per stored file, so each version of it counts.
export const archiveTotals = mapRead(shareholdingIndex.kindTotals, (indexed) =>
  Effect.succeed(
    ArchiveTotals.make({
      kinds: ReportKind.literals.map((kind) => ({
        kind,
        reports: indexed.find((row) => row.kind === kind)?.files ?? 0,
      })),
      reports: indexed.reduce((sum, { files }) => sum + files, 0),
      bytes: indexed.reduce((sum, { bytes }) => sum + bytes, 0),
    })
  )
)
