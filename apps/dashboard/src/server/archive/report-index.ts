// The report index in ArchiveDb (archive-migrations/0001_report_index.sql):
// one row per record under reports/, in either archive. R2 stays the source
// of truth. A run indexes each report right after writing its record, and
// each run starts by healing the index from its listing of reports/, which
// adds any record the index lacks, such as one whose run crashed between the
// two writes, or every record of a stage whose bucket filled first.
// Decision: the report index is a copy of R2 that each archive run heals
// (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
import { Effect, Schema } from "effect"

import { decodeRows, jsonChunks, type SqlValue, type Statement } from "../d1.ts"
import { ArchiveDb } from "./archive-db.ts"
import type { ListedObject } from "./bucket.ts"
import type { IndexedArchiveName } from "./indexed-archive.ts"
import { parseRecordName } from "./record-key.ts"
import { REPORTS_PREFIX } from "./run.ts"

// How an archive names its report kinds and its stored files, for the rows
// of its records.
export interface IndexedArchive<Kind extends string> {
  readonly name: IndexedArchiveName
  // Its report kinds, as a record's key names them.
  readonly kind: Schema.Codec<Kind>
  // The key of the file a record of `kind` is one version of.
  readonly fileKey: (
    kind: Kind,
    reportDate: string,
    sha256: string
  ) => Effect.Effect<string>
}

interface IndexedReport<Kind extends string> {
  readonly recordKey: string
  readonly kind: Kind
  // YYYY-MM-DD.
  readonly reportDate: string
  readonly sha256: string
  // An ISO instant.
  readonly fetchedAt: string
  readonly fileKey: string
  readonly fileBytes: number
  readonly recordBytes: number
}

// A statement for a page's ArchiveDb batch, and how to read its rows.
interface IndexQuery<A> {
  readonly statement: Statement
  readonly decode: (
    rows: ReadonlyArray<Record<string, unknown>>
  ) => Effect.Effect<A>
}

// Runs `query` in an ArchiveDb batch of its own.
export const runAlone = Effect.fnUntraced(function* <A>(query: IndexQuery<A>) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([query.statement])
  return yield* query.decode(rows)
})

// A kind's totals in the index.
export interface IndexedKindTotals<Kind extends string> {
  readonly kind: Kind
  // Report dates held, each once.
  readonly dates: number
  // Stored files, each version of a report counted.
  readonly files: number
  // Its files and their records.
  readonly bytes: number
}

// A date's newest version.
export interface NewestVersion {
  readonly date: string
  readonly sha256: string
}

const NewestVersionRow = Schema.Struct({
  date: Schema.String,
  sha256: Schema.String,
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

const INSERT =
  `INSERT OR IGNORE INTO archived_report (archive, ${COLUMNS.join(", ")}) ` +
  `SELECT ?, ${COLUMNS.map((_, index) => `value->>${index}`).join(", ")} ` +
  "FROM json_each(?)"

const encoder = new TextEncoder()

// One archive's rows in the report index: written by its run's `report:`
// steps, healed by its `plan`, read by its admin page. A plain function, not
// an Effect, as parseRunsOf (../holdings/parse-runs.ts) is: each archive
// calls it once at module load, and it only returns Effects.
export const reportIndexOf = <Kind extends string>(
  archive: IndexedArchive<Kind>
) => {
  const isKind = Schema.is(archive.kind)

  // The row of the record at `recordKey`, from its key alone and the two
  // sizes; undefined for a key that isn't a record of the archive.
  const indexedReport = Effect.fnUntraced(function* (
    recordKey: string,
    sizes: { readonly fileBytes: number; readonly recordBytes: number }
  ) {
    if (!recordKey.startsWith(REPORTS_PREFIX)) return undefined
    const rest = recordKey.slice(REPORTS_PREFIX.length)
    const slash = rest.indexOf("/")
    if (slash < 0) return undefined
    const kind = rest.slice(0, slash)
    const parts = yield* parseRecordName(rest.slice(slash + 1))
    if (!isKind(kind) || parts === undefined) return undefined
    return {
      recordKey,
      kind,
      reportDate: parts.date,
      sha256: parts.sha256,
      fetchedAt: parts.fetchedAt,
      fileKey: yield* archive.fileKey(kind, parts.date, parts.sha256),
      ...sizes,
    } satisfies IndexedReport<Kind>
  })

  // Inserts each report's row unless the index has it.
  // Decision: D1 inserts go in json_each chunks under D1's statement limits
  // (apps/dashboard/docs/adr/0018-d1-inserts-go-in-json-each-chunks-under-statement-limits.md)
  const indexReports = Effect.fnUntraced(function* (
    reports: ReadonlyArray<IndexedReport<Kind>>
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
    const db = yield* ArchiveDb
    for (let start = 0; start < chunks.length; start += STATEMENTS_A_BATCH)
      yield* db.batch(
        chunks
          .slice(start, start + STATEMENTS_A_BATCH)
          .map((chunk): Statement => ({
            sql: INSERT,
            params: [archive.name, chunk],
          }))
      )
  })

  const KindTotalsRow = Schema.Struct({
    kind: archive.kind,
    dates: Schema.Number,
    files: Schema.Number,
    bytes: Schema.Number,
  })

  return {
    name: archive.name,

    // Indexes the record a `report:` step just wrote, unless the index has
    // it. A failed insert is logged and never fails the step: its retry
    // would fetch the report again and write a second record, under a new
    // fetched-at. The next run's heal indexes the record instead.
    indexRecord: Effect.fnUntraced(function* (
      recordKey: string,
      fileBytes: number,
      record: string
    ) {
      const report = yield* indexedReport(recordKey, {
        fileBytes,
        recordBytes: encoder.encode(record).length,
      })
      if (report === undefined) return
      yield* indexReports([report]).pipe(
        Effect.catchTag("ArchiveDbError", (error) =>
          Effect.logWarning(
            `Report index lacks ${recordKey} until the next run heals it`,
            error
          )
        )
      )
    }),

    // Indexes every record in `objects`, a listing of reports/, that the
    // index lacks. A record whose file isn't listed is left out: a run writes
    // the file first, so only a deleted file, which never happens, leaves
    // one.
    heal: Effect.fnUntraced(function* (objects: ReadonlyArray<ListedObject>) {
      const sizes = new Map(objects.map(({ key, size }) => [key, size]))
      const reports: Array<IndexedReport<Kind>> = []
      for (const { key, size } of objects) {
        if (!key.endsWith(".json")) continue
        const report = yield* indexedReport(key, {
          fileBytes: 0,
          recordBytes: size,
        })
        const fileBytes =
          report === undefined ? undefined : sizes.get(report.fileKey)
        if (report !== undefined && fileBytes !== undefined)
          reports.push({ ...report, fileBytes })
      }
      yield* indexReports(reports)
    }),

    // Each date of `kind` indexed, oldest first, with the SHA-256 of its
    // newest version by fetched-at: what the parse coverage
    // (../holdings/parse-coverage.ts) reads. A parse run picks its months
    // the same way from a listing (newestVersions,
    // ../holdings/months-to-parse.ts), and of two versions fetched at once,
    // keeps the one listed first: the lower SHA-256.
    newestVersions: (kind: Kind) =>
      runAlone<ReadonlyArray<NewestVersion>>({
        statement: {
          sql:
            "SELECT report_date AS date, sha256 FROM (SELECT report_date, " +
            "sha256, ROW_NUMBER() OVER (PARTITION BY report_date " +
            "ORDER BY fetched_at DESC, sha256) AS rank FROM archived_report " +
            "WHERE archive = ? AND kind = ?) WHERE rank = 1 " +
            "ORDER BY report_date",
          params: [archive.name, kind],
        },
        decode: decodeRows(NewestVersionRow),
      }),

    // Each kind's totals, for each kind the index holds a report of. A
    // file's bytes count once however many records it has, each record's
    // bytes once, as a listing of reports/ counted them.
    kindTotals: {
      statement: {
        sql:
          "SELECT kind, COUNT(DISTINCT report_date) AS dates, " +
          "COUNT(*) AS files, SUM(file_bytes + record_bytes) AS bytes " +
          "FROM (SELECT kind, report_date, MAX(file_bytes) AS file_bytes, " +
          "SUM(record_bytes) AS record_bytes FROM archived_report " +
          "WHERE archive = ? GROUP BY kind, file_key) GROUP BY kind",
        params: [archive.name],
      },
      decode: decodeRows(KindTotalsRow),
    } satisfies IndexQuery<ReadonlyArray<IndexedKindTotals<Kind>>>,
  }
}
