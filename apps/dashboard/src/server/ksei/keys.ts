// The KSEI archive's R2 layout (spec apinrdw/kumora#327, "R2 layout"):
//
//   reports/<kind>/<period-end>/<sha256>.zip               written once per hash
//   reports/<kind>/<period-end>/<sha256>.<fetched-at>.<seen>.json
//                                                          one per (filename, ETag)
//   runs/<run-id>.json                                     (../archive/run.ts)
//   runs/latest.json                                       { id } of the last run
//
// Nothing under reports/ is ever overwritten or deleted.
// Decision: one exception, by hand. The owner chose on 2026-11-15 to start
// the archive at FIRST_MONTH (coverage.ts), and Production's reports before
// it were deleted once by hand. The code still deletes nothing.
import { Effect } from "effect"

import { sha256Hex } from "../archive/hash.ts"
import { REPORTS_PREFIX } from "../archive/run.ts"
import type { KseiReportKind } from "./kind.ts"

// reports/<kind>/, the prefix of every report of one kind.
export const kindPrefix = Effect.fnUntraced(function* (kind: KseiReportKind) {
  return `${REPORTS_PREFIX}${kind}/`
})

export const reportKey = Effect.fnUntraced(function* (
  kind: KseiReportKind,
  periodEnd: string,
  sha256: string
) {
  return `${yield* kindPrefix(kind)}${periodEnd}/${sha256}.zip`
})

// What a record is one of: a (filename, ETag) pair seen.
interface Seen {
  readonly filename: string
  readonly etag: string | null
}

// `fetchedAt` is an ISO instant; the key drops its colons and keeps it
// sortable.
// Decision: the key ends in a digest of the (filename, ETag) pair, as the
// shareholding archive's ends in its listing's: two pairs of the same bytes
// recorded in the same millisecond would otherwise share the spec's
// `<sha256>.<fetched-at>.json`. See apinrdw/kumora#307 and #327.
export const recordKey = Effect.fnUntraced(function* (
  kind: KseiReportKind,
  periodEnd: string,
  sha256: string,
  fetchedAt: string,
  seen: Seen
) {
  const seenDigest = (yield* sha256Hex(
    new TextEncoder().encode(`${seen.filename}\n${seen.etag ?? ""}`)
  )).slice(0, 16)
  return `${yield* kindPrefix(kind)}${periodEnd}/${sha256}.${fetchedAt.replaceAll(":", "")}.${seenDigest}.json`
})
