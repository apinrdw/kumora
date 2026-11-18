// The book event log's memory while flushes fail (spec apinrdw/kumora#517,
// "Book events"): it holds at most MAX_UNFLUSHED_EVENTS not stored yet.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, type BookEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  MAX_UNFLUSHED_EVENTS,
  makeBookEventLog,
} from "@/server/market-live/book-event-log"

const UNTR = StockCode.make("UNTR")
const T0 = Date.parse("2026-11-18T02:10:00Z")

const pulled = (n: number): BookEvent => ({
  kind: "pulled",
  code: UNTR,
  at: DateTime.makeUnsafe(T0 + n),
  side: "bid",
  price: 1_000 + n,
  lots: 6_000,
  orders: 2,
  ticks: 3,
  approached: false,
})

const emptyStore = {
  bookEventsOf: () => Effect.succeed([]),
  newestBookEvents: () => Effect.succeed([]),
}

const offsets = (events: ReadonlyArray<BookEvent>) =>
  events.map((event) => DateTime.toEpochMillis(event.at) - T0)

describe("the book event log", () => {
  it.effect(
    "a pull read two frames late lands in time order in the snapshot's newest and the code's day",
    () =>
      Effect.gen(function* () {
        const log = yield* makeBookEventLog({
          bookEventsOf: () => Effect.succeed([pulled(4)]),
          newestBookEvents: () => Effect.succeed([pulled(4)]),
        })
        yield* log.add([pulled(5)])
        yield* log.add([pulled(2)])
        assert.deepStrictEqual(
          offsets(yield* log.newest),
          [2, 4, 5],
          "the newest stay oldest first"
        )
        assert.deepStrictEqual(
          offsets(yield* log.ofCode(UNTR)),
          [2, 4, 5],
          "the code's day stays oldest first"
        )
      })
  )

  it.effect(
    "keeps the newest MAX_UNFLUSHED_EVENTS while no flush lands",
    () =>
      Effect.gen(function* () {
        const log = yield* makeBookEventLog(emptyStore)
        const all = Array.from({ length: MAX_UNFLUSHED_EVENTS + 250 }, (_, n) =>
          pulled(n)
        )
        // One minute's events at a time, every flush failing.
        for (let from = 0; from < all.length; from += 1_000)
          yield* log.add(all.slice(from, from + 1_000))
        const held = yield* log.toFlush
        assert.lengthOf(held, MAX_UNFLUSHED_EVENTS)
        assert.deepStrictEqual(held[0], all[250])
        assert.deepStrictEqual(held.at(-1), all.at(-1))
        // A flush that lands writes them all.
        yield* log.written(held.length)
        assert.lengthOf(yield* log.toFlush, 0)
      }),
    10_000
  )
})
