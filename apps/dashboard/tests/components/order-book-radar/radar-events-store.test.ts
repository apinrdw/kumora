import { assert, describe, it } from "@effect/vitest"
import {
  StockCode,
  type BookEvent,
  type OrderFlowEvent,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeRadarEventsStore } from "@/components/order-book-radar/radar-events-store"

const NOW = Date.parse("2026-11-18T09:30:00+07:00")
const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")

const eaten = (code: StockCode, at: number, price = 1_000): BookEvent => ({
  kind: "eaten",
  code,
  at: DateTime.makeUnsafe(at),
  side: "offer",
  price,
  lots: 500,
  orders: 3,
  share: 0.9,
})

const snapshot = (
  bookEvents: ReadonlyArray<BookEvent>,
  at = NOW
): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(at),
  selected: StockCode.make("IHSG"),
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
  bookEvents,
})

const delta = (
  bookEvents: ReadonlyArray<BookEvent>,
  at: number
): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(at),
  tape: [],
  candles: [],
  bookEvents,
})

const exhaustion = (code: StockCode, at: number): OrderFlowEvent => ({
  kind: "exhaustion",
  code,
  at: DateTime.makeUnsafe(at),
  side: "buy",
  price: 1_250,
  lots: 900,
  peakLots: 2_400,
  ticks: 1,
  widestTicks: 5,
})

const times = (events: ReadonlyArray<BookEvent | OrderFlowEvent>) =>
  events.map((event) => [event.code, DateTime.toEpochMillis(event.at)])

describe("the scanner's book events", () => {
  it.effect(
    "lists the snapshot's and then each delta's, newest first, and tells",
    () =>
      Effect.gen(function* () {
        const store = yield* makeRadarEventsStore
        let told = 0
        store.subscribe(() => told++)
        store.apply(
          snapshot([eaten(BBCA, NOW - 9_000), eaten(TLKM, NOW - 4_000)])
        )
        store.apply(delta([eaten(BBCA, NOW - 1_000)], NOW))
        store.apply(delta([], NOW + 250))
        assert.deepStrictEqual(times(store.events()), [
          [BBCA, NOW - 1_000],
          [TLKM, NOW - 4_000],
          [BBCA, NOW - 9_000],
        ])
        assert.strictEqual(told, 2)
      })
  )

  it.effect(
    "a later snapshot of the day, as unfolding a row sends, keeps the events already seen",
    () =>
      Effect.gen(function* () {
        const store = yield* makeRadarEventsStore
        store.apply(
          snapshot([eaten(BBCA, NOW - 9_000), eaten(TLKM, NOW - 4_000)])
        )
        store.apply(delta([eaten(BBCA, NOW - 1_000)], NOW))
        // The market's newest only, one of them already held.
        store.apply(
          snapshot([eaten(BBCA, NOW - 1_000), eaten(TLKM, NOW - 500)], NOW)
        )
        assert.deepStrictEqual(
          times(store.events()),
          [
            [TLKM, NOW - 500],
            [BBCA, NOW - 1_000],
            [TLKM, NOW - 4_000],
            [BBCA, NOW - 9_000],
          ],
          "the selection snapshot added its events without dropping or doubling any"
        )
        assert.strictEqual(store.byCode(NOW).get(BBCA)?.inFiveMinutes, 2)
      })
  )

  it.effect(
    "a pull read two frames late lands in time order, not arrival order",
    () =>
      Effect.gen(function* () {
        const store = yield* makeRadarEventsStore
        store.apply(snapshot([eaten(TLKM, NOW - 9_000)]))
        store.apply(delta([eaten(BBCA, NOW - 1_000)], NOW))
        store.apply(delta([eaten(TLKM, NOW - 3_000)], NOW + 250))
        assert.deepStrictEqual(
          times(store.events()),
          [
            [BBCA, NOW - 1_000],
            [TLKM, NOW - 3_000],
            [TLKM, NOW - 9_000],
          ],
          "the events stay newest first"
        )
      })
  )

  it.effect("a snapshot of the next day starts the list again", () =>
    Effect.gen(function* () {
      const store = yield* makeRadarEventsStore
      store.apply(snapshot([eaten(BBCA, NOW - 9_000)]))
      const tomorrow = NOW + 86_400_000
      store.apply(snapshot([eaten(TLKM, tomorrow - 2_000)], tomorrow))
      assert.deepStrictEqual(times(store.events()), [[TLKM, tomorrow - 2_000]])
      assert.isUndefined(store.byCode(tomorrow).get(BBCA))
    })
  )

  it.effect(
    "each code's last event and its count of the last 5 minutes on the object's clock",
    () =>
      Effect.gen(function* () {
        const store = yield* makeRadarEventsStore
        store.apply(
          snapshot([
            eaten(BBCA, NOW - 400_000),
            eaten(BBCA, NOW - 200_000),
            eaten(BBCA, NOW - 10_000, 1_005),
            eaten(TLKM, NOW - 600_000),
          ])
        )
        const byCode = store.byCode(NOW)
        assert.strictEqual(byCode.get(BBCA)?.inFiveMinutes, 2)
        assert.strictEqual(byCode.get(BBCA)?.last.price, 1_005)
        assert.strictEqual(byCode.get(TLKM)?.inFiveMinutes, 0)
        assert.strictEqual(
          DateTime.toEpochMillis(byCode.get(TLKM)!.last.at),
          NOW - 600_000
        )
        assert.isUndefined(byCode.get(StockCode.make("ADRO")))
      })
  )

  it.effect(
    "drops events past 5 minutes beyond the newest 200, keeping each code's last",
    () =>
      Effect.gen(function* () {
        const store = yield* makeRadarEventsStore
        store.apply(snapshot([eaten(TLKM, NOW - 600_000)]))
        const busy = Array.from({ length: 200 }, (_, index) =>
          eaten(BBCA, NOW - 400_000 + index)
        )
        store.apply(delta(busy, NOW))
        assert.strictEqual(store.events().length, 200)
        assert.isTrue(store.events().every((event) => event.code === BBCA))
        assert.strictEqual(store.byCode(NOW).get(TLKM)?.inFiveMinutes, 0)
        // Within 5 minutes, every event is kept.
        store.apply(delta([eaten(BBCA, NOW - 1_000)], NOW))
        assert.strictEqual(store.events().length, 200)
        const recent = Array.from({ length: 250 }, (_, index) =>
          eaten(BBCA, NOW - 100_000 + index)
        )
        store.apply(delta(recent, NOW))
        assert.strictEqual(store.byCode(NOW).get(BBCA)?.inFiveMinutes, 251)
      })
  )
})

describe("the scanner's order flow events", () => {
  it.effect(
    "join book events in the feed, the last event and the 5-minute count",
    () =>
      Effect.gen(function* () {
        const store = yield* makeRadarEventsStore
        store.apply({
          ...snapshot([eaten(BBCA, NOW - 9_000)]),
          orderFlowEvents: [exhaustion(TLKM, NOW - 60_000)],
        })
        store.apply({
          ...delta([eaten(TLKM, NOW - 120_000)], NOW),
          orderFlowEvents: [exhaustion(BBCA, NOW - 1_000)],
        })
        assert.deepStrictEqual(times(store.events()), [
          [BBCA, NOW - 1_000],
          [BBCA, NOW - 9_000],
          [TLKM, NOW - 60_000],
          [TLKM, NOW - 120_000],
        ])
        const byCode = store.byCode(NOW)
        assert.strictEqual(byCode.get(BBCA)?.last.kind, "exhaustion")
        assert.strictEqual(byCode.get(BBCA)?.inFiveMinutes, 2)
        assert.strictEqual(byCode.get(TLKM)?.last.kind, "exhaustion")
        assert.strictEqual(byCode.get(TLKM)?.inFiveMinutes, 2)
      })
  )
})
