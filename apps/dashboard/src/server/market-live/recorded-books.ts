// The codes whose order books a day records (spec apinrdw/kumora#555, "Books
// only for viewed codes"): a code joins the first time a viewer selects or
// watches it, and stays until the close, after every viewer leaves. The set
// is kept in `facts` (Fact.recordedBooks), so a restart keeps it.
import { StockCode } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { Fact, type makeDayStore } from "./day-store.ts"

const RecordedCodes = Schema.fromJsonString(Schema.Array(StockCode))
const encodeCodes = Schema.encodeEffect(RecordedCodes)
const decodeCodes = Schema.decodeUnknownEffect(RecordedCodes)

// Decision: a day whose store held trades but no set when its object
// started was recorded before the change, every code's books stored, so that
// object never answers a code not recorded. Its next flush writes the set,
// and from then on it records only viewed codes. A day with neither is new.
// See spec apinrdw/kumora#555, "Books only for viewed codes".
export const makeRecordedBooks = Effect.fnUntraced(function* (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) {
  const stored = yield* store.fact(Fact.recordedBooks)
  const codes = new Set<StockCode>(
    stored === undefined ? [] : yield* decodeCodes(stored)
  )
  const everyCode =
    stored === undefined && (yield* store.highestTrade) !== undefined
  // The set as the store last took it.
  let written = stored

  // Whether `code` joined just now.
  const join = (code: StockCode) =>
    Effect.sync(() => {
      if (codes.has(code)) return false
      codes.add(code)
      return true
    })

  const has = (code: StockCode) => Effect.sync(() => codes.has(code))

  // Whether the day answers `code`'s book as not recorded.
  const notRecorded = (code: StockCode) =>
    Effect.sync(() => !everyCode && !codes.has(code))

  const text = Effect.suspend(() => encodeCodes([...codes].sort()))

  // The facts the next flush writes: the set, unless the store holds it.
  const unwritten = Effect.map(
    text,
    (current): Readonly<Record<string, string>> =>
      current === written ? {} : { [Fact.recordedBooks]: current }
  )

  const hasUnwritten = Effect.map(text, (current) => current !== written)

  // The facts a flush wrote.
  const wrote = (facts: Readonly<Record<string, string>>) =>
    Effect.sync(() => {
      written = facts[Fact.recordedBooks] ?? written
    })

  return { join, has, notRecorded, unwritten, hasUnwritten, wrote }
})
