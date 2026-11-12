// Running trades of BBCA on 2026-11-09 whose exchange time trails an instant
// by a chosen feed lag, as each feed's frames carry them.
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"

import { type StockbitRow } from "./protobuf"

const WIB_OFFSET = 7 * 3_600_000

// A Stockbit trade whose exchange time is `lag` ms before `at`.
export const stockbitBefore = (
  tradeNumber: number,
  at: DateTime.Utc,
  lag: number
): StockbitRow => ({
  tradeWib: new Date(DateTime.toEpochMillis(at) - lag + WIB_OFFSET)
    .toISOString()
    .slice(11, 23),
  code: "BBCA",
  price: 9000,
  volume: 100,
  action: 1,
  board: 1,
  tradeNumber,
})

// An Ajaib TRADE frame whose exchange time is `lag` ms before `at`. Ajaib's
// times are whole seconds.
export const ajaibBefore = (
  tradeNumber: number,
  at: DateTime.Utc,
  lag: number
) =>
  JSON.stringify({
    ticker: "BBCA",
    type: "BUY",
    price: 9000,
    lot: 1,
    tradedAt: new Date(DateTime.toEpochMillis(at) - lag).toISOString(),
    tradeNum: `20261109${String(tradeNumber).padStart(10, "0")}`,
  })

// One relayed trade a second on each feed for `seconds`, each trailing the
// clock by its feed's lag in ms. Stockbit's trade numbers count up from
// `first`, then Ajaib's, so no trade is on both feeds. Returns the next
// trade number.
export const bothEverySecond = <E, R>(
  relay: {
    readonly stockbit: (
      trades: ReadonlyArray<StockbitRow>
    ) => Effect.Effect<unknown, E, R>
    readonly ajaib: (
      frames: ReadonlyArray<string>
    ) => Effect.Effect<unknown, E, R>
  },
  options: {
    readonly first: number
    readonly seconds: number
    readonly lags: { readonly Stockbit: number; readonly Ajaib: number }
  }
) =>
  Effect.gen(function* () {
    const { first, seconds, lags } = options
    for (let i = 0; i < seconds; i++) {
      const now = yield* DateTime.now
      yield* relay.stockbit([stockbitBefore(first + i, now, lags.Stockbit)])
      yield* relay.ajaib([ajaibBefore(first + seconds + i, now, lags.Ajaib)])
      yield* TestClock.adjust("1 second")
    }
    return first + 2 * seconds
  })
