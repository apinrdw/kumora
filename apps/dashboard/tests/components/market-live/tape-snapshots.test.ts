import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

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
  selected: StockCode.make("BBCA"),
  tape: [trade],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
}

const delta: ViewerDown = { _tag: "Delta", tape: [trade], candles: [] }

describe("what a viewer message changes on the tape", () => {
  it.effect("a socket's first snapshot starts the tape over", () =>
    Effect.gen(function* () {
      expect(yield* tapeChangeOf(snapshot, true)).toBe(snapshot)
    })
  )

  it.effect(
    "every later snapshot on the socket answers a Select and merges like a delta",
    () =>
      Effect.gen(function* () {
        // Two selections changed before either answer arrived: both merge.
        expect(yield* tapeChangeOf(snapshot, false)).toEqual({
          _tag: "Delta",
          tape: [trade],
          candles: [],
        })
        expect(yield* tapeChangeOf(snapshot, false)).toEqual({
          _tag: "Delta",
          tape: [trade],
          candles: [],
        })
      })
  )

  it.effect("a delta is applied as it is", () =>
    Effect.gen(function* () {
      expect(yield* tapeChangeOf(delta, false)).toBe(delta)
    })
  )
})
