// The disclosure index at the volume spec apinrdw/kumora#715 expects of the
// whole history, for the cap tests: every day from IDX's first disclosure
// day to `last` listed whole and complete, 269,000 disclosures in both
// languages spread evenly over them, and 600,000 attachments, all stored.
import { FIRST_DISCLOSURE_DAY } from "@/server/disclosures/coverage"

import type { MemoryArchiveDb } from "../archive/memory-archive-db.ts"

const DISCLOSURES = 269_000
const ATTACHMENTS = 600_000

// Rows i from 0 to `?` - 1, each with the day and key of disclosure
// i % DISCLOSURES: its day is that disclosure's number of days, cycling,
// after IDX's first disclosure day.
const ROWS =
  "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1), " +
  `numbered AS (SELECT i, i % ${DISCLOSURES} AS d FROM n), ` +
  "spread AS (SELECT i, d, date(?, '+' || (d % ?) || ' days') AS day FROM numbered), " +
  "keyed AS (SELECT i, day, replace(day, '-', '') || '090000-V/' || d AS disclosure FROM spread) "

export const seedHistory = (db: MemoryArchiveDb, last: string) => {
  const sql = db.database
  sql
    .prepare(
      "WITH RECURSIVE days(day) AS (SELECT ? UNION ALL " +
        "SELECT date(day, '+1 day') FROM days WHERE day < ?) " +
        "INSERT INTO disclosure_day (day, listed_at, complete_at) " +
        "SELECT day, day || 'T20:00:00.000Z', day || 'T20:00:00.000Z' FROM days"
    )
    .run(FIRST_DISCLOSURE_DAY, last)
  const { days } = sql
    .prepare("SELECT COUNT(*) AS days FROM disclosure_day")
    .get() as { days: number }
  for (const language of ["id", "en"])
    sql
      .prepare(
        `${ROWS}INSERT INTO disclosure_version ` +
          "(disclosure_key, language, day, object_key, stored_at) " +
          "SELECT disclosure, ?, day, 'disclosures/' || i || '/' || ?, " +
          "day || 'T20:00:00.000Z' FROM keyed"
      )
      .run(DISCLOSURES, FIRST_DISCLOSURE_DAY, days, language, language)
  sql
    .prepare(
      `${ROWS}INSERT INTO disclosure_attachment ` +
        "(disclosure_key, path, day, object_key, stored_at, bytes) " +
        "SELECT disclosure, '/StaticData/' || i || '.pdf', day, " +
        "'disclosures/files/' || i, day || 'T20:00:00.000Z', 220000 FROM keyed"
    )
    .run(ATTACHMENTS, FIRST_DISCLOSURE_DAY, days)
}
