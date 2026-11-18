// The codes whose order books a day records (spec apinrdw/kumora#555, "Books
// only for viewed codes"): a code joins the first time a viewer selects or
// watches it, and stays until the close, after every viewer leaves. The set
// is kept in `facts` (Fact.recordedBooks), so a restart keeps it.
import { StockCode } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { Fact, type makeDayStore } from "./day-store.ts"

// Every code's books, the set's value on a day recorded before the change.
const EVERY_CODE = "every-code"

const RecordedCodes = Schema.fromJsonString(
  Schema.Union([Schema.Array(StockCode), Schema.Literal(EVERY_CODE)])
)
const encodeCodes = Schema.encodeEffect(RecordedCodes)
const decodeCodes = Schema.decodeUnknownEffect(RecordedCodes)

// Decision: a day whose store held trades but no set when its object
// started was recorded before the change, so it keeps recording every code's
// books to the close and never answers a code not recorded. Its next flush
// writes the set as "every-code", so a restart keeps that. A day with
// neither is new. See spec apinrdw/kumora#555, "Books only for viewed codes".
export const makeRecordedBooks = Effect.fnUntraced(function* (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) {
  const stored = yield* store.fact(Fact.recordedBooks)
  const decoded = stored === undefined ? [] : yield* decodeCodes(stored)
  const everyCode =
    decoded === EVERY_CODE ||
    (stored === undefined && (yield* store.highestTrade) !== undefined)
  const codes = new Set<StockCode>(decoded === EVERY_CODE ? [] : decoded)
  // The set as the store last took it.
  let written = stored

  // Whether `code` joined just now.
  const join = (code: StockCode) =>
    Effect.sync(() => {
      if (everyCode || codes.has(code)) return false
      codes.add(code)
      return true
    })

  const has = (code: StockCode) =>
    Effect.sync(() => everyCode || codes.has(code))

  // Whether the day answers `code`'s book as not recorded.
  const notRecorded = (code: StockCode) =>
    Effect.sync(() => !everyCode && !codes.has(code))

  const text = Effect.suspend(() =>
    encodeCodes(everyCode ? EVERY_CODE : [...codes].sort())
  )

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
