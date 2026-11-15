// A record's key under its kind's prefix, in both archives (shareholding/
// keys.ts, ksei/keys.ts): <date>/<sha256>.<fetched-at>.<digest>.json, its
// fetched-at an ISO instant without colons, so it sorts, and its digest the
// first 16 hex of `seen`'s SHA-256, what the record is one of.
import { Effect } from "effect"

import { sha256Hex } from "./hash.ts"

export const recordName = Effect.fnUntraced(function* (
  date: string,
  sha256: string,
  fetchedAt: string,
  seen: string
) {
  const digest = (yield* sha256Hex(new TextEncoder().encode(seen))).slice(0, 16)
  return `${date}/${sha256}.${fetchedAt.replaceAll(":", "")}.${digest}.json`
})

const RECORD =
  /^(\d{4}-\d{2}-\d{2})\/([0-9a-f]{64})\.([^.]+\.\d{3}Z)\.[0-9a-f]+\.json$/

// A recordName's parts, or undefined for a name that isn't one.
export const parseRecordName = (name: string) =>
  Effect.sync(() => {
    const [, date, sha256, fetchedAt] = RECORD.exec(name) ?? []
    return date === undefined || sha256 === undefined || fetchedAt === undefined
      ? undefined
      : { date, sha256, fetchedAt }
  })
