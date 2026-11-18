import { StockCode, type BookReadings, type ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { makeBookReadingsStore } from "@/components/market-live/book-readings-store"

const side = {
  depth: 1_000_000,
  lots: 100,
  emptyTicks: 0,
  widestGap: 0,
  lotsPerOrder: 10,
}

const readings = (code: string, imbalance: number): BookReadings => ({
  code: StockCode.make(code),
  at: DateTime.makeUnsafe("2026-11-18T03:00:00Z"),
  value: 1e9,
  imbalance,
  spread: { ticks: 1, percent: 0.5 },
  limit: undefined,
  bid: side,
  offer: side,
})

const snapshot = (
  selected: string,
  bookReadings: ReadonlyArray<BookReadings>
): ViewerDown => ({
  _tag: "Snapshot",
  at: DateTime.makeUnsafe(0),
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
  bookReadings,
})

const delta = (bookReadings: ReadonlyArray<BookReadings>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(0),
  tape: [],
  candles: [],
  bookReadings,
})

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")

describe("every code's book readings", () => {
  it.effect(
    "a snapshot replaces every code's, whichever it selected; a delta's replace theirs",
    () =>
      Effect.gen(function* () {
        const store = yield* makeBookReadingsStore
        let heard = 0
        store.subscribe(() => heard++)
        store.apply(snapshot("ASII", [readings("BBCA", 0.1)]))
        expect(store.readingsOf(BBCA)?.imbalance).toBe(0.1)
        store.apply(delta([readings("TLKM", -0.3)]))
        expect(store.readingsOf(BBCA)?.imbalance).toBe(0.1)
        expect(store.readingsOf(TLKM)?.imbalance).toBe(-0.3)
        // A later snapshot without BBCA drops it.
        store.apply(snapshot("BBCA", [readings("TLKM", 0.2)]))
        expect(store.readingsOf(BBCA)).toBeUndefined()
        expect(store.readingsOf(TLKM)?.imbalance).toBe(0.2)
        expect(heard).toBe(3)
        // A delta without readings changes nothing.
        store.apply(delta([]))
        expect(heard).toBe(3)
      })
  )
})
