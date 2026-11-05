import type { PublishedSymbol } from "./published-symbol"
import type { AsOf } from "./as-of"
import { DATASETS, storedColumns, tableOf } from "./csv"
import type { Dataset, Row } from "./csv"
import type { RowFlag, StoredRow } from "./flags"
import type { RunReport } from "./run-report"

/*
 * The SQL the routes and the Workflow share. Versions order by `first_received_at`, then `rowid`:
 * two can share a millisecond, and `ownership_files` has no deletes, so `rowid` is insertion order.
 */

export type OwnershipFile = {
  readonly id: string
  readonly dataset: Dataset
  readonly as_of: AsOf
  readonly csv_sha256: string
  readonly row_count: number
}

/**
 * Inserts a file unless it lost a race: another request holds the same CSV, or the source's latest
 * version is no longer the one this file replaces. One statement, as D1 has no interactive
 * transactions. True when inserted.
 */
export const insertFile = async (
  db: D1Database,
  file: OwnershipFile & {
    readonly source_filename: string
    readonly source_sha256: string
    readonly first_received_at: string
  },
  replaces: string | null
) => {
  const latest = `(SELECT csv_sha256 FROM ownership_files WHERE source_sha256 = ?
    ORDER BY first_received_at DESC, rowid DESC LIMIT 1)`
  const inserted = await db
    .prepare(
      `INSERT INTO ownership_files
        (id, dataset, as_of, source_filename, source_sha256, csv_sha256, row_count, first_received_at, status)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'loading'
       WHERE ${latest} IS NULL OR ${latest} = ?
       ON CONFLICT (source_sha256, csv_sha256) DO NOTHING
       RETURNING id`
    )
    .bind(
      file.id,
      file.dataset,
      file.as_of,
      file.source_filename,
      file.source_sha256,
      file.csv_sha256,
      file.row_count,
      file.first_received_at,
      file.source_sha256,
      file.source_sha256,
      replaces
    )
    .first<{ id: string }>()
  return inserted !== null
}

/** Matches the `status` CHECK in `migrations/0001_ownership.sql`. Change the two together. */
export type FileStatus = "loading" | "loaded" | "failed"

export type FileVersion = {
  readonly id: string
  readonly csv_sha256: string
  readonly status: FileStatus
  readonly attempt: number
}

/** Every version received from one source file, latest first. */
export const readVersions = async (db: D1Database, sourceSha256: string) =>
  (
    await db
      .prepare(
        `SELECT id, csv_sha256, status, attempt FROM ownership_files
         WHERE source_sha256 = ? ORDER BY first_received_at DESC, rowid DESC`
      )
      .bind(sourceSha256)
      .all<FileVersion>()
  ).results

/** Moves a failed file back to loading. The next attempt, or null when another request already did. */
export const restartFile = async (db: D1Database, fileId: string) => {
  const restarted = await db
    .prepare(
      `UPDATE ownership_files SET status = 'loading', error = NULL, attempt = attempt + 1
       WHERE id = ? AND status = 'failed' RETURNING attempt`
    )
    .bind(fileId)
    .first<{ attempt: number }>()
  return restarted?.attempt ?? null
}

/** Only the file's current attempt can fail it, so a late retry undoes neither a load nor a newer attempt. */
export const markFailed = (
  db: D1Database,
  fileId: string,
  attempt: number,
  error: string
) =>
  db
    .prepare(
      "UPDATE ownership_files SET status = 'failed', error = ? WHERE id = ? AND attempt = ? AND status = 'loading'"
    )
    .bind(error, fileId, attempt)
    .run()

export const readFile = (db: D1Database, fileId: string) =>
  db
    .prepare(
      "SELECT id, dataset, as_of, csv_sha256, row_count FROM ownership_files WHERE id = ?"
    )
    .bind(fileId)
    .first<OwnershipFile>()

/** D1 binds at most this many parameters per statement. */
export const MAX_BOUND_PARAMETERS = 100

/** One atomic batch of statements, each binding as many items as D1 allows. */
const batchInChunks = async <T>(
  db: D1Database,
  items: ReadonlyArray<T>,
  columnCount: number,
  statementOf: (part: ReadonlyArray<T>, start: number) => D1PreparedStatement
) => {
  if (items.length === 0) return
  const perStatement = Math.floor(MAX_BOUND_PARAMETERS / columnCount)
  const statements = []
  for (let start = 0; start < items.length; start += perStatement)
    statements.push(
      statementOf(items.slice(start, start + perStatement), start)
    )
  await db.batch(statements)
}

/** One atomic batch. Upserting on identity makes a retried chunk change nothing. */
export const upsertRows = async (
  db: D1Database,
  dataset: Dataset,
  fileId: string,
  firstRowNo: number,
  rows: ReadonlyArray<Row>
) => {
  const data = storedColumns(dataset)
  const columns = ["file_id", "row_no", ...data]
  const placeholders = `(${columns.map(() => "?").join(", ")})`
  const updates = data.map((c) => `${c} = excluded.${c}`).join(", ")

  await batchInChunks(db, rows, columns.length, (part, start) =>
    db
      .prepare(
        `INSERT INTO ${tableOf(dataset)} (${columns.join(", ")})
         VALUES ${part.map(() => placeholders).join(", ")}
         ON CONFLICT (file_id, row_no) DO UPDATE SET ${updates}`
      )
      .bind(
        ...part.flatMap((row, i) => [
          fileId,
          firstRowNo + start + i,
          ...data.map((c) => row[c] ?? null),
        ])
      )
  )
}

/** The symbols of a file's stored rows. */
export const readSymbols = async (
  db: D1Database,
  dataset: Dataset,
  fileId: string
) =>
  (
    await db
      .prepare(
        `SELECT DISTINCT symbol FROM ${tableOf(dataset)} WHERE file_id = ? ORDER BY symbol`
      )
      .bind(fileId)
      .all<{ symbol: PublishedSymbol }>()
  ).results.map((row) => row.symbol)

/** The stored rows of these symbols, in file order. */
export const readRowsOfSymbols = async (
  db: D1Database,
  dataset: Dataset,
  fileId: string,
  symbols: ReadonlyArray<PublishedSymbol>
) =>
  (
    await db
      .prepare(
        `SELECT row_no, ${storedColumns(dataset).join(", ")} FROM ${tableOf(dataset)}
         WHERE file_id = ? AND symbol IN (${symbols.map(() => "?").join(", ")})
         ORDER BY row_no`
      )
      .bind(fileId, ...symbols)
      .all<StoredRow>()
  ).results

const FLAG_COLUMNS = 4

/** Upserting on identity makes a retried step change nothing. */
export const upsertFlags = async (
  db: D1Database,
  fileId: string,
  flags: ReadonlyArray<RowFlag>
) =>
  batchInChunks(db, flags, FLAG_COLUMNS, (part) =>
    db
      .prepare(
        `INSERT INTO row_flags (file_id, row_no, rule, detail)
         VALUES ${part.map(() => "(?, ?, ?, ?)").join(", ")}
         ON CONFLICT (file_id, row_no, rule) DO UPDATE SET detail = excluded.detail`
      )
      .bind(
        ...part.flatMap((flag) => [fileId, flag.rowNo, flag.rule, flag.detail])
      )
  )

/**
 * Sets `loaded` only with every row in, and only for the file's current attempt, so a stopped
 * attempt's late step leaves a newer one to finish. Throws on a short count, so the step fails.
 */
export const confirmLoaded = async (
  db: D1Database,
  dataset: Dataset,
  file: Pick<OwnershipFile, "id" | "row_count">,
  attempt: number
) => {
  const counted = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${tableOf(dataset)} WHERE file_id = ?`)
    .bind(file.id)
    .first<{ n: number }>()
  if (counted?.n !== file.row_count)
    throw new Error(`holds ${counted?.n} rows of ${file.row_count}`)
  await db
    .prepare(
      "UPDATE ownership_files SET status = 'loaded' WHERE id = ? AND attempt = ? AND status = 'loading'"
    )
    .bind(file.id, attempt)
    .run()
}

const readFeed = (db: D1Database, dataset: Dataset) =>
  db
    .prepare(
      `SELECT as_of, first_received_at FROM ownership_files
       WHERE dataset = ? AND status = 'loaded'
       ORDER BY as_of DESC, first_received_at DESC, rowid DESC LIMIT 1`
    )
    .bind(dataset)

/** A repeated `ranAt` is the same run sent again, and keeps the first. */
export const insertRunReport = (
  db: D1Database,
  report: RunReport,
  receivedAt: string
) =>
  db
    .prepare(
      `INSERT INTO run_reports (ran_at, received_at, outcome, detail, files_sent)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ran_at) DO NOTHING`
    )
    .bind(
      report.ranAt,
      receivedAt,
      report.outcome,
      report.detail,
      report.filesSent
    )
    .run()

/** Rows, not flags, of the version in force: the latest `loaded` file of a dataset and as-of. */
const FLAGGED_ROWS_IN_FORCE = `
  SELECT COUNT(*) AS n FROM (
    SELECT DISTINCT flag.file_id, flag.row_no
    FROM row_flags AS flag
    JOIN ownership_files AS file ON file.id = flag.file_id
    WHERE file.status = 'loaded' AND NOT EXISTS (
      SELECT 1 FROM ownership_files AS later
      WHERE later.status = 'loaded'
        AND later.dataset = file.dataset
        AND later.as_of = file.as_of
        AND (later.first_received_at, later.rowid) > (file.first_received_at, file.rowid)
    )
  )`

export type UnfinishedFile = {
  readonly id: string
  readonly dataset: Dataset
  readonly as_of: AsOf
  readonly status: Exclude<FileStatus, "loaded">
  readonly error: string | null
}

export type LatestFile = {
  readonly as_of: AsOf
  readonly first_received_at: string
}

type LastRun = Pick<RunReport, "ranAt" | "outcome" | "detail">

/** What the status response reports. `latest` runs in `DATASETS` order. */
export const readStatusRows = async (db: D1Database) => {
  const [unfinished, flagged, lastRun, ...feeds] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare(
      "SELECT id, dataset, as_of, status, error FROM ownership_files WHERE status != 'loaded' ORDER BY first_received_at"
    ),
    db.prepare(FLAGGED_ROWS_IN_FORCE),
    db.prepare(
      "SELECT ran_at AS ranAt, outcome, detail FROM run_reports ORDER BY ran_at DESC LIMIT 1"
    ),
    ...DATASETS.map((dataset) => readFeed(db, dataset)),
  ])
  return {
    files: (unfinished?.results ?? []) as Array<UnfinishedFile>,
    flaggedRows: (flagged?.results[0] as { n: number } | undefined)?.n ?? 0,
    lastRun: (lastRun?.results[0] as LastRun | undefined) ?? null,
    latest: feeds.map((feed) => feed.results[0] as LatestFile | undefined),
  }
}
