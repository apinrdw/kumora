import {
  StockCode,
  TradeNumber,
  type RunningTrade,
  type Sweep,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { makeSweepStore } from "@/components/market-live/sweep-store"

const UNTR = StockCode.make("UNTR")

const trade = (
  number: number,
  time: string,
  side: RunningTrade["side"],
  lots: number,
  code = "UNTR"
): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time: DateTime.makeUnsafe(`2026-11-09T${time}+07:00`),
  code: StockCode.make(code),
  price: 1_000,
  lots,
  side,
  board: "RG",
  feeds: ["Stockbit"],
})

const snapshot: ViewerDown = {
  _tag: "Snapshot",
  selected: UNTR,
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
}

const delta = (tape: ReadonlyArray<RunningTrade>): ViewerDown => ({
  _tag: "Delta",
  tape,
  candles: [],
})

// A sweep as the test compares it: [side, WIB time, lots, trades].
const shape = (sweep: Sweep) => [
  sweep.side,
  DateTime.formatIso(sweep.time),
  sweep.lots,
  sweep.trades,
]

describe("the selected code's sweeps, live", () => {
  it.effect(
    "hold the delta trades until the GET answers, then group only those numbered above it onto its sweeps",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        const asked = store.awaiting()
        expect(asked).toBe(1)
        // 101 is in the answer; 103 carries its last sweep on.
        store.apply(
          delta([
            trade(101, "09:00:10.100", "buy", 2),
            trade(102, "09:00:10.200", "sell", 9, "BBCA"),
            trade(103, "09:00:10.500", "buy", 3),
          ])
        )
        expect(store.sweeps()).toEqual([])
        store.answer(asked!, {
          code: UNTR,
          through: TradeNumber.make("102"),
          sweeps: [
            {
              side: "buy",
              time: DateTime.makeUnsafe("2026-11-09T09:00:10.100+07:00"),
              first: 1_000,
              last: 1_000,
              lots: 2,
              value: 200_000,
              trades: 1,
            },
          ],
        })
        expect(store.awaiting()).toBeUndefined()
        expect(store.sweeps().map(shape)).toEqual([
          ["buy", "2026-11-09T02:00:10.100Z", 5, 2],
        ])
      })
  )

  it.effect(
    "a late trade splits a sweep already grouped, and a trade sent again with its side changed is grouped once",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        store.answer(store.awaiting()!, { code: UNTR, sweeps: [] })
        store.apply(
          delta([
            trade(201, "09:00:20.100", "buy", 1),
            trade(203, "09:00:20.300", "buy", 1),
          ])
        )
        expect(store.sweeps().map(shape)).toEqual([
          ["buy", "2026-11-09T02:00:20.100Z", 2, 2],
        ])
        store.apply(delta([trade(202, "09:00:20.200", "sell", 4)]))
        // A second feed's copy of 202 names no side.
        store.apply(delta([trade(202, "09:00:20.200", "none", 4)]))
        expect(store.sweeps().map(shape)).toEqual([
          ["buy", "2026-11-09T02:00:20.100Z", 1, 1],
          ["none", "2026-11-09T02:00:20.200Z", 4, 1],
          ["buy", "2026-11-09T02:00:20.300Z", 1, 1],
        ])
      })
  )

  it.effect("an answer for an earlier snapshot is dropped", () =>
    Effect.gen(function* () {
      const store = yield* makeSweepStore(UNTR)
      store.apply(snapshot)
      store.apply(snapshot)
      store.answer(1, { code: UNTR, sweeps: [] })
      expect(store.awaiting()).toBe(2)
    })
  )
})
