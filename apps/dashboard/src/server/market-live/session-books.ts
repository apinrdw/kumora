// Each code's last book served in Sessions 1 and 2, kept in the day store
// when each session ends, so a restarted object brings back the book and the
// session's readings of every code, recorded or not (recorded-books.ts).
import {
  READING_PHASES,
  encodeBookChunk,
  type MarketPhase,
  type OrderBook,
  type StockCode,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { SessionBook } from "./day-store.ts"

export const makeSessionBooks = Effect.sync(() => {
  // The books served in a session since the store last took them.
  let unwritten = new Map<StockCode, OrderBook>()

  // Books viewers were sent in `phase`: only a session's are kept.
  const served = (books: ReadonlyArray<OrderBook>, phase: MarketPhase) =>
    Effect.sync(() => {
      if (!READING_PHASES.has(phase)) return
      for (const book of books) unwritten.set(book.code, book)
    })

  // The books a flush writes: none inside a session, every one kept since
  // the last write once it ended, the first flush in the break or past
  // Session 2, and at the seal (day-store.ts, `session_books`).
  const take = Effect.fnUntraced(function* (
    phase: MarketPhase,
    final: boolean
  ) {
    if (!final && READING_PHASES.has(phase)) return []
    const taken = unwritten
    unwritten = new Map()
    const rows: Array<SessionBook> = []
    for (const book of taken.values())
      rows.push({
        code: book.code,
        chunk: yield* encodeBookChunk({
          code: book.code,
          minute: DateTime.makeUnsafe(
            Math.floor(DateTime.toEpochMillis(book.at) / MINUTE_MS) * MINUTE_MS
          ),
          start: book,
          deltas: [],
        }),
      })
    return rows
  })

  // Whether a session's books wait for its end, which keeps the flush armed
  // through it, so its first wake past the end writes them.
  const hasUnwritten = Effect.sync(() => unwritten.size > 0)

  // Whether a flush in `phase` writes books.
  const due = (phase: MarketPhase) =>
    Effect.sync(() => unwritten.size > 0 && !READING_PHASES.has(phase))

  return { served, take, hasUnwritten, due }
})
