// The report index in ArchiveDb (archive-migrations/0001_report_index.sql):
// one row per record under reports/, in either archive. R2 stays the source
// of truth. A run indexes each report right after writing its record, and
// each run starts by healing the index from its listing of reports/, which
// adds any record the index lacks, such as one whose run crashed between the
// two writes, or every record of a stage whose bucket filled first.
// Decision: the report index is a copy of R2 that each archive run heals
// (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
import { Effect, Schema } from "effect"

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

interface IndexedReport {
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
const indexedReport = Effect.fnUntraced(function* (
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
const indexReports = Effect.fnUntraced(function* (
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

// Indexes the record a `report:` step just wrote, unless the index has it.
// A failed insert is logged and never fails the step: its retry would fetch
// the report again and write a second record, under a new fetched-at. The
// next run's heal indexes the record instead.
export const indexStoredRecord = Effect.fnUntraced(function* (
  archive: IndexedArchive,
  recordKey: string,
  sizes: { readonly fileBytes: number; readonly recordBytes: number }
) {
  const report = yield* indexedReport(archive, recordKey, sizes)
  if (report === undefined) return
  yield* indexReports(archive.archive, [report]).pipe(
    Effect.catchTag("ArchiveDbError", (error) =>
      Effect.logWarning(
        `Report index lacks ${recordKey} until the next run heals it`,
        error
      )
    )
  )
})

const NewestVersionRow = Schema.Struct({
  date: Schema.String,
  sha256: Schema.String,
})

// Each date of `kind` indexed in `archive`, oldest first, with the SHA-256 of
// its newest version by fetched-at: what the parse coverage
// (../holdings/parse-coverage.ts) reads. A parse run picks its months the
// same way from a listing (newestVersions, ../holdings/months-to-parse.ts),
// and of two versions fetched at once, keeps the one listed first: the
// lower SHA-256.
export const newestIndexedVersions = Effect.fnUntraced(function* (
  archive: IndexedArchiveName,
  kind: string
) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql:
        "SELECT report_date AS date, sha256 FROM (SELECT report_date, sha256, " +
        "ROW_NUMBER() OVER (PARTITION BY report_date " +
        "ORDER BY fetched_at DESC, sha256) AS rank FROM archived_report " +
        "WHERE archive = ? AND kind = ?) WHERE rank = 1 ORDER BY report_date",
      params: [archive, kind],
    },
  ])
  return yield* Schema.decodeUnknownEffect(Schema.Array(NewestVersionRow))(
    rows
  ).pipe(Effect.orDie)
})
