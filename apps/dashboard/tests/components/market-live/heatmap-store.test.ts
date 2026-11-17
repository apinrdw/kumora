import {
  StockCode,
  WibDate,
  type OrderBook,
  type RecordedHeatmap,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { makeHeatmapStore } from "@/components/market-live/heatmap-store"

const UNTR = StockCode.make("UNTR")
const DAY = WibDate.make("2026-11-09")
const wib = (time: string) => Date.parse(`2026-11-09T${time}+07:00`)

// A book as of `at`: the instant it was served, near enough.
const book = (
  at: number,
  bid: number,
  offer: number,
  code = UNTR
): OrderBook => ({
  _tag: "OrderBook",
  code,
  bids: [{ price: 8_000, lots: bid, orders: 1 }],
  offers: [{ price: 8_025, lots: offer, orders: 1 }],
  bidLots: bid,
  offerLots: offer,
  at: DateTime.makeUnsafe(at),
  provenance: "Stockbit",
})

const delta = (...orderBooks: ReadonlyArray<OrderBook>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(0),
  tape: [],
  candles: [],
  orderBooks,
})

// The snapshot of UNTR, with its book when it has one.
const snapshot = (orderBook?: OrderBook): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(0),
  selected: UNTR,
  tape: [],
  candles: [],
  footprints: [],
  ...(orderBook === undefined ? {} : { orderBook }),
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

// The GET's answer: one slice at 14:20:00, up to 14:20:10.
const answer: RecordedHeatmap = {
  code: UNTR,
  through: DateTime.makeUnsafe(wib("14:20:10")),
  slices: [
    { at: DateTime.makeUnsafe(wib("14:20:00")), levels: [[8_000, 7, 0]] },
  ],
}

// The store's slices as [WIB time, levels].
const shown = (store: Effect.Success<ReturnType<typeof makeHeatmapStore>>) =>
  store
    .slices()
    .map((slice) => [
      DateTime.formatIso(DateTime.add(slice.at, { hours: 7 })).slice(11, 19),
      slice.levels,
    ])

describe("the heatmap store", () => {
  it.effect(
    "joins the GET's slices to the ones it builds from the books after them, with no gap and no overlap",
    () =>
      Effect.gen(function* () {
        let now = wib("14:20:12")
        const store = yield* makeHeatmapStore(UNTR, DAY, () => now)
        // The snapshot's book, before the GET answers: in force from its
        // join.
        store.apply(snapshot(book(now, 50, 40)))
        store.answer(store.awaiting()!, answer)
        expect(shown(store)).toEqual([
          ["14:20:00", [[8_000, 7, 0]]],
          [
            "14:20:10",
            [
              [8_000, 50, 0],
              [8_025, 0, 40],
            ],
          ],
        ])
        // Another code's book changes nothing; this code's at 14:20:15 is
        // weighed from then.
        now = wib("14:20:15")
        store.apply(
          delta(book(now, 1, 1, StockCode.make("BBCA")), book(now, 90, 40))
        )
        expect(shown(store).at(-1)).toEqual([
          "14:20:10",
          [
            [8_000, 70, 0],
            [8_025, 0, 40],
          ],
        ])
        // A new slice starts with the book in force.
        now = wib("14:20:21")
        store.tick()
        expect(shown(store).slice(1)).toEqual([
          [
            "14:20:10",
            [
              [8_000, 70, 0],
              [8_025, 0, 40],
            ],
          ],
          [
            "14:20:20",
            [
              [8_000, 90, 0],
              [8_025, 0, 40],
            ],
          ],
        ])
      })
  )

  it.effect(
    "weighs the books on the object's clock, however far the browser's runs off it",
    () =>
      Effect.gen(function* () {
        // The browser's clock reads an hour behind.
        const behind = 3_600_000
        let now = wib("14:20:12") - behind
        const store = yield* makeHeatmapStore(UNTR, DAY, () => now)
        store.apply(snapshot())
        store.answer(store.awaiting()!, answer)
        store.apply(delta(book(wib("14:20:12"), 50, 40)))
        now = wib("14:20:15") - behind
        store.apply(delta(book(wib("14:20:15"), 90, 40)))
        // No book until 14:20:12: 50 lots for 3 s, then 90 for 5 s.
        expect(shown(store).at(-1)).toEqual([
          "14:20:10",
          [
            [8_000, 60, 0],
            [8_025, 0, 32],
          ],
        ])
      })
  )

  it.effect("a recorded day's answer is the whole day: it builds nothing", () =>
    Effect.gen(function* () {
      const store = yield* makeHeatmapStore(UNTR, DAY, () => wib("16:00:00"))
      store.seed(answer)
      store.apply(delta(book(wib("16:00:00"), 90, 40)))
      store.tick()
      expect(shown(store)).toEqual([["14:20:00", [[8_000, 7, 0]]]])
    })
  )
})
