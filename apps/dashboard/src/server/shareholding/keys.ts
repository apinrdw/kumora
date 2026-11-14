// The shareholding archive's R2 layout (spec apinrdw/kumora#303, "R2 layout"):
//
//   reports/<kind>/<data-date>/<sha256>.xlsx               written once per hash
//   reports/<kind>/<data-date>/<sha256>.<fetched-at>.json  one per listing seen
//   runs/<run-id>.json
//   runs/latest.json                                       { id } of the last run
//
// Nothing under reports/ is ever overwritten or deleted.
import { Effect } from "effect"

import type { ReportKind } from "./listing.ts"

export const REPORTS_PREFIX = "reports/"
export const LATEST_RUN_KEY = "runs/latest.json"

export const reportKey = Effect.fnUntraced(function* (
  kind: ReportKind,
  dataDate: string,
  sha256: string
) {
  return `${REPORTS_PREFIX}${kind}/${dataDate}/${sha256}.xlsx`
})

// `fetchedAt` is an ISO instant; the key drops its colons and keeps it
// sortable.
export const recordKey = Effect.fnUntraced(function* (
  kind: ReportKind,
  dataDate: string,
  sha256: string,
  fetchedAt: string
) {
  return `${REPORTS_PREFIX}${kind}/${dataDate}/${sha256}.${fetchedAt.replaceAll(":", "")}.json`
})

export const runKey = Effect.fnUntraced(function* (id: string) {
  return `runs/${id}.json`
})
