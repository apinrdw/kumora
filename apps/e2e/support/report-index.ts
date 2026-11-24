// Seeds an archive's bucket with a report and the report index in the Test
// stage's ArchiveDb, in archive-migrations/0001_report_index.sql's columns,
// as an archive run's `report:` step stores a report and indexes its record.
import type { IndexedArchiveName } from "../../dashboard/src/server/archive/indexed-archive.ts"
import { putObject } from "./archive-bucket"
import { writeTo } from "./local-d1"

// Each archive's bucket.
const BUCKET: Record<IndexedArchiveName, string> = {
  ksei: "KseiArchiveBucket",
  shareholding: "ShareholdingArchiveBucket",
}

/**
 * Stores a report's file, then its record, in `archive`'s bucket, and
 * indexes the record.
 */
export async function storeIndexedReport(
  archive: IndexedArchiveName,
  report: {
    readonly kind: string
    readonly reportDate: string
    readonly sha256: string
    // An ISO instant.
    readonly fetchedAt: string
    readonly fileKey: string
    readonly file: string | Uint8Array<ArrayBuffer>
    readonly contentType: string
    readonly recordKey: string
    readonly record: string
  }
) {
  await putObject(
    BUCKET[archive],
    report.fileKey,
    report.file,
    report.contentType
  )
  await putObject(
    BUCKET[archive],
    report.recordKey,
    report.record,
    "application/json"
  )
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
      typeof report.file === "string"
        ? new TextEncoder().encode(report.file).length
        : report.file.length,
      new TextEncoder().encode(report.record).length
    )
  })
}

/**
 * Stores a report under `reports/<prefix>/`, `<kind>/<report date>`, as a
 * run would: `bytes` bytes of file named `<hash>.<extension>`, then a record
 * fetched at `fetchedAt`.
 */
export async function seedSizedReport(
  archive: IndexedArchiveName,
  report: {
    readonly prefix: string
    readonly hash: string
    readonly bytes: number
    readonly extension: string
    readonly contentType: string
    readonly fetchedAt: string
  }
) {
  const [kind = "", reportDate = ""] = report.prefix.split("/")
  const stamp = report.fetchedAt.replaceAll(/[-:.]/g, "")
  await storeIndexedReport(archive, {
    kind,
    reportDate,
    sha256: report.hash,
    fetchedAt: report.fetchedAt,
    fileKey: `reports/${report.prefix}/${report.hash}.${report.extension}`,
    file: "x".repeat(report.bytes),
    contentType: report.contentType,
    recordKey: `reports/${report.prefix}/${report.hash}.${stamp}.0000.json`,
    record: JSON.stringify({ sha256: report.hash }),
  })
}
