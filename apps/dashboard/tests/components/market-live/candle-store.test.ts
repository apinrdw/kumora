import {
  StockCode,
  type Candle,
  type Footprint,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  makeCandleStore,
  type CandleChange,
} from "@/components/market-live/candle-store"

const candle = (code: string, close: number): Candle => ({
  code: StockCode.make(code),
  minute: DateTime.makeUnsafe("2026-11-09T09:00:00+07:00"),
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  value: close * 100,
  frequency: 1,
})

// A footprint of one cell, at 09:00 WIB plus `minutes`.
const footprint = (code: string, buy: number, minutes = 0): Footprint => ({
  code: StockCode.make(code),
  minute: DateTime.makeUnsafe(
    Date.parse("2026-11-09T09:00:00+07:00") + minutes * 60_000
  ),
  cells: [{ price: 4_000, sell: 0, buy, none: 0 }],
})

// The snapshot answering a Select of `selected`.
const snapshot = (
  selected: string,
  candles: ReadonlyArray<Candle>,
  footprints: ReadonlyArray<Footprint> = []
): ViewerDown => ({
  _tag: "Snapshot",
  selected: StockCode.make(selected),
  tape: [],
  candles,
  footprints,
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

describe("the selected code's candles", () => {
  it.effect(
    "a snapshot answering an earlier Select of another code changes nothing; this code's replaces them",
    () =>
      Effect.gen(function* () {
        const store = yield* makeCandleStore(StockCode.make("BBRI"))
        const heard: Array<CandleChange> = []
        store.subscribe((change) => heard.push(change))
        // The page moved from BBCA to BBRI before BBCA's snapshot arrived.
        store.apply(snapshot("BBCA", [candle("BBCA", 9_000)]))
        expect(store.candles()).toEqual([])
        expect(heard).toEqual([])
        store.apply(snapshot("BBRI", [candle("BBRI", 4_000)]))
        expect(store.candles()).toEqual([candle("BBRI", 4_000)])
        expect(heard).toEqual([{ _tag: "Reset" }])
      })
  )
})

describe("the selected code's footprints", () => {
  it.effect(
    "come with its snapshot; a delta's of this code replace theirs by minute, another code's change nothing",
    () =>
      Effect.gen(function* () {
        const store = yield* makeCandleStore(StockCode.make("BBRI"))
        const heard: Array<CandleChange> = []
        store.subscribe((change) => heard.push(change))
        store.apply(
          snapshot("BBRI", [], [footprint("BBRI", 1), footprint("BBRI", 2, 1)])
        )
        store.apply({
          _tag: "Delta",
          tape: [],
          candles: [],
          footprints: [footprint("BBCA", 9), footprint("BBRI", 5)],
        })
        expect(store.footprints()).toEqual([
          footprint("BBRI", 5),
          footprint("BBRI", 2, 1),
        ])
        expect(heard).toEqual([
          { _tag: "Reset" },
          { _tag: "Update", candles: [], footprints: [footprint("BBRI", 5)] },
        ])
        // A delta with nothing of this code is not heard.
        store.apply({
          _tag: "Delta",
          tape: [],
          candles: [],
          footprints: [footprint("BBCA", 3)],
        })
        expect(heard).toHaveLength(2)
      })
  )

  it.effect(
    "a delta's footprint with no cells drops its minute's footprint and candle; a candle the same delta carries stays",
    () =>
      Effect.gen(function* () {
        const store = yield* makeCandleStore(StockCode.make("BBRI"))
        const heard: Array<CandleChange> = []
        const emptied: Footprint = { ...footprint("BBRI", 0), cells: [] }
        store.apply(
          snapshot("BBRI", [candle("BBRI", 4_000)], [footprint("BBRI", 1)])
        )
        store.subscribe((change) => heard.push(change))
        // The minute's candle still has its figures: only its cells went.
        store.apply({
          _tag: "Delta",
          tape: [],
          candles: [candle("BBRI", 4_025)],
          footprints: [emptied],
        })
        expect(store.candles()).toEqual([candle("BBRI", 4_025)])
        expect(store.footprints()).toEqual([])
        // Its last regular-board trade left the minute.
        store.apply({
          _tag: "Delta",
          tape: [],
          candles: [],
          footprints: [emptied],
        })
        expect(store.candles()).toEqual([])
        expect(store.footprints()).toEqual([])
        expect(heard).toEqual([{ _tag: "Dropped" }, { _tag: "Dropped" }])
      })
  )
})
