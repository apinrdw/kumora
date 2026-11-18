import { describe, expect, it } from "@effect/vitest"
import {
  StockCode,
  type BookEvent,
  type OrderBook,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeBookEventStore } from "@/components/market-live/book-event-store"

const T0 = Date.parse("2026-11-17T02:10:00Z")

const event = (code: string, seconds: number): BookEvent => ({
  kind: "eaten",
  code: StockCode.make(code),
  at: DateTime.makeUnsafe(T0 + seconds * 1000),
  side: "bid",
  price: 100,
  lots: 50_000,
  orders: 12,
  share: 0.9,
})

const book = (
  code: string,
  bidSecond: number,
  offerSecond: number
): OrderBook => ({
  _tag: "OrderBook",
  code: StockCode.make(code),
  bids: [],
  offers: [],
  bidLots: 0,
  offerLots: 0,
  at: DateTime.makeUnsafe(T0 + Math.max(bidSecond, offerSecond) * 1000),
  bidAt: DateTime.makeUnsafe(T0 + bidSecond * 1000),
  offerAt: DateTime.makeUnsafe(T0 + offerSecond * 1000),
  provenance: "Stockbit",
})

const snapshot = (
  selected: string,
  selectedBookEvents: ReadonlyArray<BookEvent>,
  orderBook?: OrderBook
): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(T0),
  selected: StockCode.make(selected),
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
  selectedBookEvents,
  ...(orderBook === undefined ? {} : { orderBook }),
})

const delta = (
  bookEvents: ReadonlyArray<BookEvent>,
  orderBooks?: ReadonlyArray<OrderBook>
): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(T0),
  tape: [],
  candles: [],
  bookEvents,
  ...(orderBooks === undefined ? {} : { orderBooks }),
})

const seconds = (events: ReadonlyArray<BookEvent>) =>
  events.map((each) => (DateTime.toEpochMillis(each.at) - T0) / 1000)

describe("book event store", () => {
  it.effect(
    "a snapshot of its code replaces the events and a delta adds its code's",
    () =>
      Effect.gen(function* () {
        const store = yield* makeBookEventStore(StockCode.make("FOLK"))
        store.apply(snapshot("FOLK", [event("FOLK", 1)]))
        store.apply(snapshot("BBNI", [event("BBNI", 2)]))
        store.apply(delta([event("BBNI", 3), event("FOLK", 4)]))
        expect(seconds(store.events())).toEqual([1, 4])
        store.apply(snapshot("FOLK", []))
        expect(store.events()).toEqual([])
      })
  )

  it.effect(
    "a recorded day's answer replaces them and says if it kept any",
    () =>
      Effect.gen(function* () {
        const code = StockCode.make("FOLK")
        const store = yield* makeBookEventStore(code)
        expect(store.recorded()).toBe(true)
        store.load({ code, recorded: false, events: [] })
        expect(store.recorded()).toBe(false)
        store.load({ code, recorded: true, events: [event("FOLK", 7)] })
        expect(seconds(store.events())).toEqual([7])
      })
  )

  it.effect("too quiet while neither side had 2 frames in the last 30 s", () =>
    Effect.gen(function* () {
      const store = yield* makeBookEventStore(StockCode.make("FOLK"))
      store.apply(snapshot("FOLK", [], book("FOLK", 0, 0)))
      expect(store.quiet(T0 + 1_000)).toBe(true)
      store.apply(delta([], [book("FOLK", 10, 0)]))
      // Bids at 0 and 10, offers at 0 alone.
      expect(store.quiet(T0 + 11_000)).toBe(false)
      // At 31 s only the bid frame at 10 is in the window.
      expect(store.quiet(T0 + 31_000)).toBe(true)
    })
  )

  it.effect("tells its listeners when an event is picked", () =>
    Effect.gen(function* () {
      const store = yield* makeBookEventStore(StockCode.make("FOLK"))
      let told = 0
      store.subscribe(() => told++)
      store.pick("FOLK|eaten|bid|100|1")
      expect([store.picked(), told]).toEqual(["FOLK|eaten|bid|100|1", 1])
    })
  )
})
