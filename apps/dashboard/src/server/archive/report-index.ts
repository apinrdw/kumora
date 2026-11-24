// The report index in ArchiveDb (archive-migrations/0001_report_index.sql):
// one row per record under reports/, in either archive. R2 stays the source
// of truth. A run indexes each report right after writing its record, and
// each run starts by healing the index from its listing of reports/, which
// adds any record the index lacks, such as one whose run crashed between the
// two writes, or every record of a stage whose bucket filled first.
// Decision: the report index is a copy of R2 that each archive run heals
// (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
import { Effect } from "effect"

import type { SqlValue, Statement } from "../d1.ts"
import { jsonChunks } from "../d1.ts"
import { ArchiveDb } from "./archive-db.ts"
import type { ListedObject } from "./bucket.ts"
import { parseRecordName } from "./record-key.ts"
import { REPORTS_PREFIX } from "./run.ts"

// Which archive a row is of: each has its own bucket and run machinery.
export type IndexedArchiveName = "ksei" | "shareholding"

// How an archive names its stored files, for the rows of its records.
export interface IndexedArchive {
  readonly archive: IndexedArchiveName
  // The key of the file a record of `kind` is one version of; undefined for
  // a kind the archive doesn't have.
  readonly fileKey: (
    kind: string,
    reportDate: string,
    sha256: string
  ) => Effect.Effect<string | undefined>
}

export interface IndexedReport {
  readonly recordKey: string
  readonly kind: string
  // YYYY-MM-DD.
  readonly reportDate: string
  readonly sha256: string
  // An ISO instant.
  readonly fetchedAt: string
  readonly fileKey: string
  readonly fileBytes: number
  readonly recordBytes: number
}

// The row of the record at `recordKey`, from its key alone and the two
// sizes; undefined for a key that isn't a record of `archive`.
export const indexedReport = Effect.fnUntraced(function* (
  archive: IndexedArchive,
  recordKey: string,
  sizes: { readonly fileBytes: number; readonly recordBytes: number }
) {
  if (!recordKey.startsWith(REPORTS_PREFIX)) return undefined
  const rest = recordKey.slice(REPORTS_PREFIX.length)
  const slash = rest.indexOf("/")
  const kind = rest.slice(0, slash)
  const parts = yield* parseRecordName(rest.slice(slash + 1))
  if (slash < 0 || parts === undefined) return undefined
  const fileKey = yield* archive.fileKey(kind, parts.date, parts.sha256)
  if (fileKey === undefined) return undefined
  return {
    recordKey,
    kind,
    reportDate: parts.date,
    sha256: parts.sha256,
    // The key's fetched-at has its colons dropped: 2026-11-14T030000.000Z.
    fetchedAt: parts.fetchedAt.replace(/T(\d{2})(\d{2})(\d{2})/, "T$1:$2:$3"),
    fileKey,
    ...sizes,
  } satisfies IndexedReport
})

const COLUMNS = [
  "record_key",
  "kind",
  "report_date",
  "sha256",
  "fetched_at",
  "file_key",
  "file_bytes",
  "record_bytes",
] as const

// The most statements one batch sends: 10 chunks of at most 90,000 bytes.
const STATEMENTS_A_BATCH = 10

// Inserts each report's row unless the index has it.
// Decision: D1 inserts go in json_each chunks under D1's statement limits
// (apps/dashboard/docs/adr/0018-d1-inserts-go-in-json-each-chunks-under-statement-limits.md)
export const indexReports = Effect.fnUntraced(function* (
  archive: IndexedArchiveName,
  reports: ReadonlyArray<IndexedReport>
) {
  const chunks = yield* jsonChunks(
    reports.map((report): ReadonlyArray<SqlValue> => [
      report.recordKey,
      report.kind,
      report.reportDate,
      report.sha256,
      report.fetchedAt,
      report.fileKey,
      report.fileBytes,
      report.recordBytes,
    ])
  )
  const sql =
    `INSERT OR IGNORE INTO archived_report (archive, ${COLUMNS.join(", ")}) ` +
    `SELECT ?, ${COLUMNS.map((_, index) => `value->>${index}`).join(", ")} ` +
    "FROM json_each(?)"
  const db = yield* ArchiveDb
  for (let start = 0; start < chunks.length; start += STATEMENTS_A_BATCH)
    yield* db.batch(
      chunks
        .slice(start, start + STATEMENTS_A_BATCH)
        .map((chunk): Statement => ({ sql, params: [archive, chunk] }))
    )
})

// Indexes every record in `objects`, a listing of reports/, that the index
// lacks. A record whose file isn't listed is left out: a run writes the file
// first, so only a deleted file, which never happens, leaves one.
export const healIndex = Effect.fnUntraced(function* (
  archive: IndexedArchive,
  objects: ReadonlyArray<ListedObject>
) {
  const sizes = new Map(objects.map(({ key, size }) => [key, size]))
  const reports: Array<IndexedReport> = []
  for (const { key, size } of objects) {
    if (!key.endsWith(".json")) continue
    const report = yield* indexedReport(archive, key, {
      fileBytes: 0,
      recordBytes: size,
    })
    const fileBytes =
      report === undefined ? undefined : sizes.get(report.fileKey)
    if (report !== undefined && fileBytes !== undefined)
      reports.push({ ...report, fileBytes })
  }
  yield* indexReports(archive.archive, reports)
})
