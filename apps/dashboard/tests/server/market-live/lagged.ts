// Running trades of BBCA on 2026-11-09 whose exchange time trails an instant
// by a chosen feed lag, as each feed's frames carry them.
import { DateTime } from "effect"

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
