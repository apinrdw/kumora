// The shareholding archive's totals per report kind, for the admin page
// (spec apinrdw/kumora#303, "The admin page"), from the report index
// (report-index.ts) in one ArchiveDb statement.
import { Effect, Schema } from "effect"

import { ArchiveDb } from "../archive/archive-db.ts"
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

const KindRow = Schema.Struct({
  kind: ReportKind,
  reports: Schema.Number,
  bytes: Schema.Number,
})

// A report counts once per stored file, so each version of it counts. A
// file's bytes count once however many records it has, each record's bytes
// once, as a listing of reports/ counted them.
export const archiveTotals = Effect.gen(function* () {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql:
        "SELECT kind, COUNT(*) AS reports, " +
        "SUM(file_bytes + record_bytes) AS bytes " +
        "FROM (SELECT kind, MAX(file_bytes) AS file_bytes, " +
        "SUM(record_bytes) AS record_bytes FROM archived_report " +
        "WHERE archive = ? GROUP BY kind, file_key) GROUP BY kind",
      params: ["shareholding"],
    },
  ])
  const indexed = yield* Schema.decodeUnknownEffect(Schema.Array(KindRow))(
    rows
  ).pipe(Effect.orDie)
  return ArchiveTotals.make({
    kinds: ReportKind.literals.map((kind) => ({
      kind,
      reports: indexed.find((row) => row.kind === kind)?.reports ?? 0,
    })),
    reports: indexed.reduce((sum, { reports }) => sum + reports, 0),
    bytes: indexed.reduce((sum, { bytes }) => sum + bytes, 0),
  })
})
