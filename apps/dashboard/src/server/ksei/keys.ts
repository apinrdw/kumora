// The KSEI archive's R2 layout (spec apinrdw/kumora#327, "R2 layout"):
//
//   reports/<kind>/<period-end>/<sha256>.zip               written once per hash
//   reports/<kind>/<period-end>/<sha256>.<fetched-at>.<seen>.json
//                                                          one per (filename, ETag)
//   runs/<run-id>.json                                     (../archive/run.ts)
//   runs/latest.json                                       { id } of the last run
//   parse-runs/<run-id>.json, parse-runs/latest.json       the KSEI parse runs'
//                                                          (parse-runs.ts)
//
// Nothing under reports/ is ever overwritten or deleted.
// Decision: the KSEI archive keeps November 2018 onward only
// (apps/dashboard/docs/adr/0049-the-ksei-archive-starts-at-november-2018.md)
import { Effect } from "effect"

import { recordName } from "../archive/record-key.ts"
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
// Decision: a record key ends in a digest of its listing
// (apps/dashboard/docs/adr/0050-an-archive-record-key-ends-in-a-digest-of-its-listing.md)
export const recordKey = Effect.fnUntraced(function* (
  kind: KseiReportKind,
  periodEnd: string,
  sha256: string,
  fetchedAt: string,
  seen: Seen
) {
  return `${yield* kindPrefix(kind)}${yield* recordName(periodEnd, sha256, fetchedAt, `${seen.filename}\n${seen.etag ?? ""}`)}`
})
