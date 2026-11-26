// The disclosure archive's index in ArchiveDb
// (archive-migrations/0005_disclosure_index.sql): a row per stored
// disclosure version, a row per attachment its versions list, once per
// disclosure and path, and when a run last listed each disclosure day and
// when the day became complete. A run decides from it what the archive
// lacks, and never lists the bucket.
import { DateTime, Duration, Effect, Schema } from "effect"

import { ArchiveDb } from "../archive/archive-db.ts"
import type { PageRead } from "../archive/page-read.ts"
import { decodeRows, jsonChunks, type SqlValue, type Statement } from "../d1.ts"
import {
  attachmentKey,
  DisclosureKey,
  type DisclosureLanguage,
  versionKey,
} from "./key.ts"

// The most statements one batch sends: 10 chunks of at most 90,000 bytes.
const STATEMENTS_A_BATCH = 10

const INSERT_VERSIONS =
  "INSERT OR IGNORE INTO disclosure_version " +
  "(disclosure_key, language, day, object_key, stored_at) " +
  "SELECT value->>0, value->>1, value->>2, value->>3, value->>4 " +
  "FROM json_each(?)"

const INSERT_ATTACHMENTS =
  "INSERT OR IGNORE INTO disclosure_attachment " +
  "(disclosure_key, path, day, object_key) " +
  "SELECT value->>0, value->>1, value->>2, value->>3 FROM json_each(?)"

// The disclosure keys of `day` the archive holds a version of in
// `language`.
export const heldVersions = Effect.fnUntraced(function* (
  day: string,
  language: DisclosureLanguage
) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql: "SELECT disclosure_key FROM disclosure_version WHERE day = ? AND language = ?",
      params: [day, language],
    },
  ])
  return new Set(
    (yield* decodeRows(Schema.Struct({ disclosure_key: Schema.String }))(
      rows
    )).map(({ disclosure_key }) => disclosure_key)
  )
})

// A version just stored in the bucket, and the paths of its attachments.
export interface StoredVersion {
  readonly key: DisclosureKey
  readonly language: DisclosureLanguage
  readonly day: string
  readonly paths: ReadonlyArray<string>
}

// Indexes each version, and each of its attachments the index lacks, to be
// stored. A row already there stays as it is.
// Decision: D1 inserts go in json_each chunks under D1's statement limits
// (apps/dashboard/docs/adr/0018-d1-inserts-go-in-json-each-chunks-under-statement-limits.md)
export const indexVersions = Effect.fnUntraced(function* (
  versions: ReadonlyArray<StoredVersion>,
  storedAt: string
) {
  const versionRows: Array<ReadonlyArray<SqlValue>> = []
  const attachmentRows: Array<ReadonlyArray<SqlValue>> = []
  for (const version of versions) {
    versionRows.push([
      version.key,
      version.language,
      version.day,
      yield* versionKey(version.key, version.language),
      storedAt,
    ])
    for (const path of version.paths)
      attachmentRows.push([
        version.key,
        path,
        version.day,
        yield* attachmentKey(version.key, path),
      ])
  }
  // Attachments first: a version indexed is one whose attachments wait to
  // be stored, should the batch after this one fail.
  const statements: Array<Statement> = [
    ...(yield* jsonChunks(attachmentRows)).map((chunk) => ({
      sql: INSERT_ATTACHMENTS,
      params: [chunk],
    })),
    ...(yield* jsonChunks(versionRows)).map((chunk) => ({
      sql: INSERT_VERSIONS,
      params: [chunk],
    })),
  ]
  const db = yield* ArchiveDb
  for (let start = 0; start < statements.length; start += STATEMENTS_A_BATCH)
    yield* db.batch(statements.slice(start, start + STATEMENTS_A_BATCH))
})

// Records that a run has listed `day` in both languages.
export const recordDayListed = Effect.fnUntraced(function* (
  day: string,
  listedAt: string
) {
  yield* (yield* ArchiveDb).batch([
    {
      sql:
        "INSERT INTO disclosure_day (day, listed_at) VALUES (?, ?) " +
        "ON CONFLICT (day) DO UPDATE SET listed_at = excluded.listed_at",
      params: [day, listedAt],
    },
  ])
})

// An attachment row that waits to be stored: what keeps its day from being
// complete. The one place that says so, for the runs and the coverage alike.
// An unavailable attachment no longer waits.
// Decision: an attachment whose failures span 7 days is unavailable
// (apps/dashboard/docs/adr/0139-an-attachment-failing-for-7-days-is-unavailable.md)
const WAITING = "stored_at IS NULL AND unavailable_at IS NULL"

// Rows of the days in a bound JSON array.
const IN_DAYS = "day IN (SELECT value FROM json_each(?))"

// A disclosure day a run has listed: when it last did, when the day became
// complete, and how many of its attachments wait to be stored.
const ListedDay = Schema.Struct({
  day: Schema.String,
  listed_at: Schema.String,
  complete_at: Schema.NullOr(Schema.String),
  waiting: Schema.Number,
})
export type ListedDay = typeof ListedDay.Type

// One row per listed day from `from` on, oldest first: a row a day, ~1,240
// from IDX's first disclosure day to 2026-11-26. Its waiting count reads
// the partial index of waiting attachments, never the stored ones.
const listedDaysStatement = (from: string): Statement => ({
  sql:
    "SELECT day, listed_at, complete_at, (SELECT COUNT(*) FROM " +
    `disclosure_attachment AS a WHERE a.day = d.day AND ${WAITING}) ` +
    "AS waiting FROM disclosure_day AS d WHERE day >= ? ORDER BY day",
  params: [from],
})

const decodeListedDays = decodeRows(ListedDay)

export const listedDays = Effect.fnUntraced(function* (from: string) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    listedDaysStatement(from),
  ])
  return yield* decodeListedDays(rows)
})

// listedDays as a part of an admin page's read.
export const listedDaysRead = (from: string) =>
  ({
    kinds: [],
    statements: [listedDaysStatement(from)],
    read: ([rows = []]) => decodeListedDays(rows),
  }) satisfies PageRead<ReadonlyArray<ListedDay>>

// The oldest disclosure day the archive holds a version of, or null: the
// first entry of disclosure_version_day.
export const earliestDayRead = {
  kinds: [],
  statements: [
    { sql: "SELECT MIN(day) AS day FROM disclosure_version", params: [] },
  ],
  read: ([rows = []]) =>
    Effect.map(
      decodeRows(Schema.Struct({ day: Schema.NullOr(Schema.String) }))(rows),
      ([row]) => row?.day ?? null
    ),
} satisfies PageRead<string | null>

// Records `days` complete at `completeAt`; one already complete keeps its
// instant.
export const recordDaysComplete = Effect.fnUntraced(function* (
  days: ReadonlyArray<string>,
  completeAt: string
) {
  if (days.length === 0) return
  yield* (yield* ArchiveDb).batch([
    {
      sql:
        "UPDATE disclosure_day SET complete_at = ? " +
        `WHERE complete_at IS NULL AND ${IN_DAYS}`,
      params: [completeAt, JSON.stringify(days)],
    },
  ])
})

// An attachment that waits to be stored.
const WaitingAttachment = Schema.Struct({
  disclosure: DisclosureKey,
  path: Schema.String,
})
export type WaitingAttachment = typeof WaitingAttachment.Type

// Up to `limit` attachments of `days` that wait to be stored, in the order
// `days` names their days.
export const waitingAttachments = Effect.fnUntraced(function* (
  days: ReadonlyArray<string>,
  limit: number
) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql:
        // json_each has a `path` column of its own.
        "SELECT a.disclosure_key AS disclosure, a.path " +
        "FROM json_each(?) AS listed JOIN disclosure_attachment AS a " +
        `ON a.day = listed.value WHERE ${WAITING} ` +
        "ORDER BY listed.key, a.disclosure_key, a.path LIMIT ?",
      params: [JSON.stringify(days), limit],
    },
  ])
  return yield* decodeRows(WaitingAttachment)(rows)
})

// How many attachments of `days` wait to be stored.
export const waitingCount = Effect.fnUntraced(function* (
  days: ReadonlyArray<string>
) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql:
        "SELECT COUNT(*) AS waiting FROM disclosure_attachment " +
        `WHERE ${WAITING} AND ${IN_DAYS}`,
      params: [JSON.stringify(days)],
    },
  ])
  const [row] = yield* decodeRows(Schema.Struct({ waiting: Schema.Number }))(
    rows
  )
  return row?.waiting ?? 0
})

// Whether the attachment is stored already.
export const isAttachmentStored = Effect.fnUntraced(function* (
  attachment: WaitingAttachment
) {
  const [rows = []] = yield* (yield* ArchiveDb).batch([
    {
      sql:
        "SELECT 1 AS stored FROM disclosure_attachment WHERE disclosure_key = ? " +
        "AND path = ? AND stored_at IS NOT NULL",
      params: [attachment.disclosure, attachment.path],
    },
  ])
  return rows.length > 0
})

export const markAttachmentStored = Effect.fnUntraced(function* (
  attachment: WaitingAttachment,
  storedAt: string,
  bytes: number
) {
  yield* (yield* ArchiveDb).batch([
    {
      sql:
        "UPDATE disclosure_attachment SET stored_at = ?, bytes = ?, " +
        "first_failed_at = NULL, last_error = NULL " +
        "WHERE disclosure_key = ? AND path = ?",
      params: [storedAt, bytes, attachment.disclosure, attachment.path],
    },
  ])
})

// How long an attachment's failures span before it is unavailable.
const UNAVAILABLE_AFTER = Duration.days(7)

// Records a failed download: when the first was, and the last's message.
// A failure UNAVAILABLE_AFTER or more after the first makes it unavailable.
// Decision: an attachment whose failures span 7 days is unavailable
// (apps/dashboard/docs/adr/0139-an-attachment-failing-for-7-days-is-unavailable.md)
export const markAttachmentFailed = Effect.fnUntraced(function* (
  attachment: WaitingAttachment,
  failedAt: string,
  message: string
) {
  // Both instants are formatIso's, so they compare as strings. The CASE
  // reads first_failed_at as it was before this failure.
  const since = DateTime.formatIso(
    DateTime.subtractDuration(DateTime.makeUnsafe(failedAt), UNAVAILABLE_AFTER)
  )
  yield* (yield* ArchiveDb).batch([
    {
      sql:
        "UPDATE disclosure_attachment SET " +
        "first_failed_at = COALESCE(first_failed_at, ?), last_error = ?, " +
        "unavailable_at = CASE WHEN first_failed_at <= ? THEN ? END " +
        "WHERE disclosure_key = ? AND path = ? AND stored_at IS NULL",
      params: [
        failedAt,
        message,
        since,
        failedAt,
        attachment.disclosure,
        attachment.path,
      ],
    },
  ])
})
