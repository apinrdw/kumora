import { StockCode, type Candle, type ViewerDown } from "@workspace/relay"
import { DateTime } from "effect"
import { describe, expect, test } from "vitest"

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

// The snapshot answering a Select of `selected`.
const snapshot = (
  selected: string,
  candles: ReadonlyArray<Candle>
): ViewerDown => ({
  _tag: "Snapshot",
  selected: StockCode.make(selected),
  tape: [],
  candles,
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

describe("the selected code's candles", () => {
  test("a snapshot answering an earlier Select of another code changes nothing; this code's replaces them", () => {
    const store = makeCandleStore(StockCode.make("BBRI"))
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
})
