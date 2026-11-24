// The KSEI archive's rows in the report index (../archive/report-index.ts):
// written by its run's `report:` steps, healed by its `plan`, read by the
// admin page for the totals and the coverage.
import { Effect, Schema } from "effect"

import { ArchiveDb } from "../archive/archive-db.ts"
import type { ListedObject } from "../archive/bucket.ts"
import {
  healIndex,
  type IndexedArchive,
  indexedReport,
  indexReports,
} from "../archive/report-index.ts"
import { reportKey } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import { kseiTotals } from "./totals.ts"

const isKind = Schema.is(KseiReportKind)

const KSEI: IndexedArchive = {
  archive: "ksei",
  fileKey: (kind, periodEnd, sha256) =>
    isKind(kind) ? reportKey(kind, periodEnd, sha256) : Effect.undefined,
}

// Indexes the record a `report:` step just wrote, unless the index has it.
export const indexKseiReport = Effect.fnUntraced(function* (
  recordKey: string,
  sizes: { readonly fileBytes: number; readonly recordBytes: number }
) {
  const report = yield* indexedReport(KSEI, recordKey, sizes)
  if (report !== undefined) yield* indexReports(KSEI.archive, [report])
})

// Indexes every record in `objects`, a listing of reports/, the index lacks.
export const healKseiIndex = (objects: ReadonlyArray<ListedObject>) =>
  healIndex(KSEI, objects)

const KindTotalsRow = Schema.Struct({
  kind: KseiReportKind,
  reports: Schema.Number,
  versions: Schema.Number,
  bytes: Schema.Number,
})

const HeldMonthRow = Schema.Struct({
  kind: KseiReportKind,
  month: Schema.String,
})

// Each kind's totals and the months it holds (YYYY-MM), in one ArchiveDb
// batch. A file's bytes count once however many records it has, each record's
// bytes once, as a listing of reports/ counted them.
export const kseiReportIndex = Effect.gen(function* () {
  const [totalsRows = [], monthRows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql:
        "SELECT kind, COUNT(DISTINCT report_date) AS reports, " +
        "COUNT(*) AS versions, SUM(file_bytes + record_bytes) AS bytes " +
        "FROM (SELECT kind, report_date, MAX(file_bytes) AS file_bytes, " +
        "SUM(record_bytes) AS record_bytes FROM archived_report " +
        "WHERE archive = ? GROUP BY kind, file_key) GROUP BY kind",
      params: ["ksei"],
    },
    {
      sql:
        "SELECT DISTINCT kind, substr(report_date, 1, 7) AS month " +
        "FROM archived_report WHERE archive = ?",
      params: ["ksei"],
    },
  ])
  const kinds = yield* Schema.decodeUnknownEffect(Schema.Array(KindTotalsRow))(
    totalsRows
  ).pipe(Effect.orDie)
  const months = yield* Schema.decodeUnknownEffect(Schema.Array(HeldMonthRow))(
    monthRows
  ).pipe(Effect.orDie)
  const held = (kind: KseiReportKind) =>
    new Set(months.filter((row) => row.kind === kind).map(({ month }) => month))
  return {
    totals: yield* kseiTotals(kinds),
    monthsHeld: {
      "securities-statistics": held("securities-statistics"),
      "securities-holdings": held("securities-holdings"),
    },
  }
})
