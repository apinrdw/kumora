// The shareholding archive's R2 layout (spec apinrdw/kumora#303, "R2 layout"):
//
//   reports/<kind>/<data-date>/<sha256>.xlsx               written once per hash
//   reports/<kind>/<data-date>/<sha256>.<fetched-at>.<listing>.json
//                                                          one per listing seen
//   runs/<run-id>.json                                     (../archive/run.ts)
//   runs/latest.json                                       { id } of the last run
//
// Nothing under reports/ is ever overwritten or deleted.
import { Effect } from "effect"

import type { ReportKind } from "./listing.ts"

export const REPORTS_PREFIX = "reports/"

// reports/<kind>/, the prefix of every report of one kind.
export const kindPrefix = Effect.fnUntraced(function* (kind: ReportKind) {
  return `${REPORTS_PREFIX}${kind}/`
})

export const reportKey = Effect.fnUntraced(function* (
  kind: ReportKind,
  dataDate: string,
  sha256: string
) {
  return `${yield* kindPrefix(kind)}${dataDate}/${sha256}.xlsx`
})

export const sha256Hex = Effect.fnUntraced(function* (
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>
) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", bytes)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
})

// A record is one per listing, a (source URL, ETag) pair.
interface Listing {
  readonly sourceUrl: string
  readonly etag: string | null
}

// `fetchedAt` is an ISO instant; the key drops its colons and keeps it
// sortable.
// Decision: the key ends in a digest of the listing, so two listings of the
// same bytes recorded in the same millisecond (one run storing a file IDX
// uploaded twice) get two keys instead of one overwriting the other. The
// spec's `<sha256>.<fetched-at>.json` alone can't tell them apart. See
// apinrdw/kumora#307.
export const recordKey = Effect.fnUntraced(function* (
  kind: ReportKind,
  dataDate: string,
  sha256: string,
  fetchedAt: string,
  listing: Listing
) {
  const listingDigest = (yield* sha256Hex(
    new TextEncoder().encode(`${listing.sourceUrl}\n${listing.etag ?? ""}`)
  )).slice(0, 16)
  return `${yield* kindPrefix(kind)}${dataDate}/${sha256}.${fetchedAt.replaceAll(":", "")}.${listingDigest}.json`
})
