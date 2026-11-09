import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime } from "effect"
import { describe, expect, test } from "vitest"

import { tapeChangeOf } from "@/components/market-live/tape-snapshots"

const trade: RunningTrade = {
  tradeNumber: TradeNumber.make("1"),
  time: DateTime.makeUnsafe("2026-11-09T09:00:00+07:00"),
  code: StockCode.make("BBCA"),
  price: 9_000,
  lots: 1,
  side: "buy",
  board: "RG",
  feeds: ["Ajaib"],
}

const snapshot: ViewerDown = {
  _tag: "Snapshot",
  tape: [trade],
  candles: [],
  status: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
}

const delta: ViewerDown = { _tag: "Delta", tape: [trade], candles: [] }

describe("what a viewer message changes on the tape", () => {
  test("a socket's first snapshot starts the tape over", () => {
    expect(tapeChangeOf(snapshot, true)).toBe(snapshot)
  })

  test("every later snapshot on the socket answers a Select and merges like a delta", () => {
    // Two selections changed before either answer arrived: both merge.
    expect(tapeChangeOf(snapshot, false)).toEqual({
      _tag: "Delta",
      tape: [trade],
      candles: [],
    })
    expect(tapeChangeOf(snapshot, false)).toEqual({
      _tag: "Delta",
      tape: [trade],
      candles: [],
    })
  })

  test("a delta is applied as it is", () => {
    expect(tapeChangeOf(delta, false)).toBe(delta)
  })
})
