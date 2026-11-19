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

// Decision: a code joins only if the day's code list (code-list.ts) names
// it, so the set holds listed codes alone: Ajaib's 3,406 and the indices.
// Before the list arrives, at most UNLISTED_LIMIT join. At 16 characters a
// code, the fact stays under 150 KB, well below Durable Object SQLite's 2 MB
// row.
const UNLISTED_LIMIT = 4_000

// Decision: a day whose tape is a row per trade (tape.ts, `makeTape`) was
// recorded before the change: it records every code's books to the close,
// never answers a code not recorded, and writes no set. Every day since is
// chunked from its first trade, so its set starts empty. See spec
// apinrdw/kumora#555, "Books only for viewed codes".
export const makeRecordedBooks = Effect.fnUntraced(function* (
  store: Effect.Success<ReturnType<typeof makeDayStore>>
) {
  const everyCode = store.tapeShape === "rows"
  const stored = everyCode ? undefined : yield* store.fact(Fact.recordedBooks)
  const codes = new Set<StockCode>(
    stored === undefined ? [] : yield* decodeCodes(stored)
  )
  // The set as the store last took it.
  let written = stored

  // Whether `code` joined just now, given the codes the day's list names.
  const join = (code: StockCode, listed: ReadonlySet<StockCode> | undefined) =>
    Effect.sync(() => {
      if (everyCode || codes.has(code)) return false
      if (
        listed === undefined ? codes.size >= UNLISTED_LIMIT : !listed.has(code)
      )
        return false
      codes.add(code)
      return true
    })

  const has = (code: StockCode) =>
    Effect.sync(() => everyCode || codes.has(code))

  // Whether the day answers `code`'s book as not recorded.
  const notRecorded = (code: StockCode) =>
    Effect.sync(() => !everyCode && !codes.has(code))

  // The set's text when the store lacks it.
  const unwrittenText = Effect.suspend(() =>
    everyCode
      ? Effect.succeed(undefined)
      : Effect.map(encodeCodes([...codes].sort()), (current) =>
          current === written ? undefined : current
        )
  )

  // The facts the next flush writes: the set, unless the store holds it.
  const unwritten = Effect.map(
    unwrittenText,
    (text): Readonly<Record<string, string>> =>
      text === undefined ? {} : { [Fact.recordedBooks]: text }
  )

  const hasUnwritten = Effect.map(unwrittenText, (text) => text !== undefined)

  // The facts a flush wrote.
  const wrote = (facts: Readonly<Record<string, string>>) =>
    Effect.sync(() => {
      written = facts[Fact.recordedBooks] ?? written
    })

  return { join, has, notRecorded, unwritten, hasUnwritten, wrote }
})
