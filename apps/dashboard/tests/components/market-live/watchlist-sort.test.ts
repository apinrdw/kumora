import { describe, expect, it } from "@effect/vitest"
import { StockCode, type DayState } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  nextWatchlistSort,
  sortWatchlist,
  watchlistSortOf,
} from "@/components/market-live/watchlist-sort"

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")
const IHSG = StockCode.make("IHSG")
const WIFI = StockCode.make("WIFI")

const stateOf = (
  code: StockCode,
  last: number,
  percent?: number
): DayState => ({
  code,
  last,
  ...(percent !== undefined && { change: { amount: 1, percent } }),
  open: last,
  high: last,
  low: last,
  volume: 1,
  value: last,
  frequency: 1,
  asOf: DateTime.makeUnsafe("2026-11-09T09:00:00+07:00"),
  provenance: "Stockbit",
})

const snapshot = new Map([
  [BBCA, stateOf(BBCA, 9_800, 0.01)],
  [TLKM, stateOf(TLKM, 3_100, -0.02)],
  // An index: no previous close, so no change.
  [IHSG, stateOf(IHSG, 7_000)],
])
// WIFI has no Day state yet.
const CODES = [WIFI, BBCA, IHSG, TLKM]

describe("the watchlist's sort", () => {
  it.effect(
    "orders by a Day state figure, codes without it last either way",
    () =>
      Effect.gen(function* () {
        expect(
          yield* sortWatchlist(CODES, snapshot, { key: "change", dir: "desc" })
        ).toEqual([BBCA, TLKM, WIFI, IHSG])
        expect(
          yield* sortWatchlist(CODES, snapshot, { key: "change", dir: "asc" })
        ).toEqual([TLKM, BBCA, WIFI, IHSG])
        expect(
          yield* sortWatchlist(CODES, snapshot, { key: "last", dir: "desc" })
        ).toEqual([BBCA, IHSG, TLKM, WIFI])
        expect(
          yield* sortWatchlist(CODES, snapshot, { key: "code", dir: "asc" })
        ).toEqual([BBCA, IHSG, TLKM, WIFI])
      })
  )

  it.effect(
    "a header click sorts its column's first way, then the other, then the order added",
    () =>
      Effect.gen(function* () {
        const value1 = yield* nextWatchlistSort(undefined, "value")
        expect(value1).toEqual({ key: "value", dir: "desc" })
        const value2 = yield* nextWatchlistSort(value1, "value")
        expect(value2).toEqual({ key: "value", dir: "asc" })
        expect(yield* nextWatchlistSort(value2, "value")).toBeUndefined()
        expect(yield* nextWatchlistSort(value2, "code")).toEqual({
          key: "code",
          dir: "asc",
        })
      })
  )

  it.effect("a column in the URL without a direction sorts its first way", () =>
    Effect.gen(function* () {
      expect(yield* watchlistSortOf({ sort: "frequency" })).toEqual({
        key: "frequency",
        dir: "desc",
      })
      expect(yield* watchlistSortOf({ sort: "code" })).toEqual({
        key: "code",
        dir: "asc",
      })
      expect(yield* watchlistSortOf({ dir: "asc" })).toBeUndefined()
    })
  )
})
