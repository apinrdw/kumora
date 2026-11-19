// The book event log's memory while flushes fail (spec apinrdw/kumora#517,
// "Book events"): it holds at most MAX_UNFLUSHED_EVENTS not stored yet. And
// when it reads the store's newest: only once a snapshot asks.
import { assert, describe, it } from "@effect/vitest"
import {
  MAX_CODE_BOOK_EVENTS,
  StockCode,
  type BookEvent,
} from "@workspace/relay"
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
    "reads the store's newest once, when a snapshot first asks, and never before",
    () =>
      Effect.gen(function* () {
        // The store as a flush leaves it.
        const stored = [pulled(4)]
        let reads = 0
        const log = yield* makeBookEventLog({
          bookEventsOf: () => Effect.succeed([]),
          newestBookEvents: () =>
            Effect.sync(() => {
              reads += 1
              return [...stored]
            }),
        })
        yield* log.add([pulled(5)])
        stored.push(...(yield* log.toFlush))
        yield* log.written(1)
        yield* log.add([pulled(2)])
        assert.strictEqual(reads, 0, "a start and an event read nothing")
        assert.deepStrictEqual(
          offsets(yield* log.newest),
          [2, 4, 5],
          "the stored and the unflushed, each once"
        )
        yield* log.add([pulled(7)])
        assert.deepStrictEqual(offsets(yield* log.newest), [2, 4, 5, 7])
        assert.strictEqual(reads, 1, "the next snapshot reads memory")
      })
  )

  it.effect(
    "a code's day holds its newest MAX_CODE_BOOK_EVENTS, stored and not",
    () =>
      Effect.gen(function* () {
        const stored = Array.from({ length: MAX_CODE_BOOK_EVENTS }, (_, n) =>
          pulled(n)
        )
        const log = yield* makeBookEventLog({
          bookEventsOf: () => Effect.succeed(stored),
          newestBookEvents: () => Effect.succeed([]),
        })
        const later = Array.from({ length: 300 }, (_, n) =>
          pulled(MAX_CODE_BOOK_EVENTS + n)
        )
        yield* log.add(later)
        const day = yield* log.ofCode(UNTR)
        assert.lengthOf(day, MAX_CODE_BOOK_EVENTS, "the code's day is capped")
        assert.deepStrictEqual(day[0], stored[300], "the oldest drop first")
        assert.deepStrictEqual(day.at(-1), later.at(-1))
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
