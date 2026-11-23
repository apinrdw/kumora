// The shareholding archive's R2 layout (spec apinrdw/kumora#303, "R2 layout"):
//
//   reports/<kind>/<data-date>/<sha256>.xlsx               written once per hash
//   reports/<kind>/<data-date>/<sha256>.<fetched-at>.<listing>.json
//                                                          one per listing seen
//   runs/<run-id>.json                                     (../archive/run.ts)
//   runs/latest.json                                       { id } of the last run
//   parse-runs/<kind>/<run-id>.json                        one per parse run of
//                                                          the kind (../holdings/
//                                                          parse-runs.ts)
//   parse-runs/<kind>/latest.json                          { id } of its last
//
// Nothing under reports/ is ever overwritten or deleted.
import { Effect } from "effect"

import { recordName } from "../archive/record-key.ts"
import { REPORTS_PREFIX } from "../archive/run.ts"
import type { ReportKind } from "./listing.ts"

// reports/<kind>/, the prefix of every report of one kind.
export const kindPrefix = Effect.fnUntraced(function* (kind: ReportKind) {
  return `${REPORTS_PREFIX}${kind}/`
})

// seedReportFixture (apps/e2e/support/shareholding.ts) writes this key and
// recordKey's by hand, since it can't load this module: a change here
// changes it too.
export const reportKey = Effect.fnUntraced(function* (
  kind: ReportKind,
  dataDate: string,
  sha256: string
) {
  return `${yield* kindPrefix(kind)}${dataDate}/${sha256}.xlsx`
})

// A record is one per listing, a (source URL, ETag) pair.
interface Listing {
  readonly sourceUrl: string
  readonly etag: string | null
}

// `fetchedAt` is an ISO instant; the key drops its colons and keeps it
// sortable.
// Decision: a record key ends in a digest of its listing
// (apps/dashboard/docs/adr/0050-an-archive-record-key-ends-in-a-digest-of-its-listing.md)
export const recordKey = Effect.fnUntraced(function* (
  kind: ReportKind,
  dataDate: string,
  sha256: string,
  fetchedAt: string,
  listing: Listing
) {
  return `${yield* kindPrefix(kind)}${yield* recordName(dataDate, sha256, fetchedAt, `${listing.sourceUrl}\n${listing.etag ?? ""}`)}`
})
