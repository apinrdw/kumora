// Seeds the report index in the Test stage's ArchiveDb, in
// archive-migrations/0001_report_index.sql's columns, as an archive run's
// `report:` step indexes the record it just stored.
import { writeTo } from "./local-d1"

export function indexRecord(
  archive: "ksei" | "shareholding",
  report: {
    readonly recordKey: string
    readonly kind: string
    readonly reportDate: string
    readonly sha256: string
    readonly fetchedAt: string
    readonly fileKey: string
    readonly fileBytes: number
    readonly record: string
  }
) {
  writeTo("ArchiveDb", (db) => {
    db.prepare(
      "INSERT OR IGNORE INTO archived_report (archive, record_key, kind, " +
        "report_date, sha256, fetched_at, file_key, file_bytes, record_bytes) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      archive,
      report.recordKey,
      report.kind,
      report.reportDate,
      report.sha256,
      report.fetchedAt,
      report.fileKey,
      report.fileBytes,
      new TextEncoder().encode(report.record).length
    )
  })
}
