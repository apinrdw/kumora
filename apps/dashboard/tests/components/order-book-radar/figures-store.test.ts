import { assert, describe, it } from "@effect/vitest"
import { StockCode, type Candle, type ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeFiguresStore } from "@/components/order-book-radar/figures-store"

const BBCA = StockCode.make("BBCA")
const at = DateTime.makeUnsafe("2026-11-18T02:30:00.000Z")

const candle = (minute: string, close: number): Candle => ({
  code: BBCA,
  minute: DateTime.makeUnsafe(minute),
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
  value: close * 100,
  buyValue: 0,
  sellValue: 0,
  frequency: 1,
})

const snapshot: ViewerDown = {
  _tag: "Snapshot",
  at,
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
  scannerFigures: [
    {
      code: BBCA,
      last: 7_500,
      previousClose: 7_450,
      previousValue: 2e12,
    },
  ],
}

const delta = (candles: ReadonlyArray<Candle>): ViewerDown => ({
  _tag: "Delta",
  at,
  tape: [],
  candles,
})

describe("the scanner's figures", () => {
  it.effect(
    "come from snapshots and deltas' figures, never from a delta's candles",
    () =>
      Effect.gen(function* () {
        const store = yield* makeFiguresStore
        store.apply(snapshot)
        // A backfill's 09:00 minute, older than the snapshot's last price.
        store.apply(delta([candle("2026-11-18T02:00:00.000Z", 7_300)]))
        assert.deepStrictEqual(store.all().get(BBCA), {
          last: 7_500,
          previousClose: 7_450,
          previousValue: 2e12,
        })
        store.apply({
          ...delta([]),
          scannerFigures: [{ code: BBCA, last: 7_525, previousClose: 7_450 }],
        })
        assert.deepStrictEqual(store.all().get(BBCA), {
          last: 7_525,
          previousClose: 7_450,
        })
        store.apply({ ...snapshot, scannerFigures: [] })
        assert.isUndefined(store.all().get(BBCA))
      })
  )
})
