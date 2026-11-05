import { Exit, Schema } from "effect"

import { SYMBOL_PATTERN } from "@/domain/symbol-guard"
import type { Symbol } from "@/domain/symbol"
import { Trade } from "@/domain/trade"
import type { TradeSide } from "@/domain/trade"

import { CASH_BOARD, NEGOTIATED_BOARD, REGULAR_BOARD } from "./exchange"
import type { RawTrade } from "./stockbit"
import { tradingDay } from "./trading-day"

const SIDE: Record<number, TradeSide> = { 1: "buy", 2: "sell" }
const BOARD: Record<number, string> = {
  1: REGULAR_BOARD,
  2: CASH_BOARD,
  3: NEGOTIATED_BOARD,
}

const decodeTrade = Schema.decodeUnknownExit(Trade)

export type Decoded = {
  readonly trades: ReadonlyArray<Trade>
  /** Trades Schema refused. */
  readonly failed: number
}

/**
 * Maps a batch to the domain, one trade at a time: a whole-market batch carries
 * warrants and rights, and none of them may lose the batch.
 */
export const toTrades = (
  raws: ReadonlyArray<RawTrade>,
  receivedAt: string
): Decoded => {
  const trades: Array<Trade> = []
  let failed = 0
  for (const raw of raws) {
    // Codes that are not stocks, such as the warrant PYFA-W, are no failure.
    if (!SYMBOL_PATTERN.test(raw.stock)) continue
    const exit = decodeTrade({
      symbol: raw.stock,
      price: raw.price,
      volume: raw.volume,
      value: raw.value,
      side: SIDE[raw.action] ?? "unspecified",
      board: BOARD[raw.board] ?? "UNSPECIFIED",
      tradeNumber: raw.tradeNumber,
      tradedAt: raw.time,
      receivedAt,
      change: raw.change,
    })
    if (Exit.isSuccess(exit)) trades.push(exit.value)
    else failed++
  }
  return { trades, failed }
}

/**
 * Works out the day per trade. The newest day in the batch wins when it is ahead
 * of `current`, and the caller clears on `cleared`, the first day too: rows can
 * predate it. Older trades go, because Stockbit's resend on subscribe can carry
 * the previous day's.
 */
export const keepCurrentDay = (
  current: string | null,
  trades: ReadonlyArray<Trade>
): {
  readonly day: string | null
  readonly cleared: boolean
  readonly trades: ReadonlyArray<Trade>
} => {
  const days = trades.map((t) => tradingDay(t.tradedAt))
  let day = current
  for (const d of days) if (day === null || d > day) day = d
  return {
    day,
    cleared: day !== null && day !== current,
    trades: trades.filter((_, i) => days[i] === day),
  }
}

/**
 * Drops every trade at or below the last trade number seen for its symbol.
 * Within a symbol, numbers rose on every live batch; the only repeats are
 * Stockbit's 40-trade resend on subscribe and a source switch. Mutates `last`.
 */
export const dedupe = (
  last: Map<Symbol, number>,
  trades: ReadonlyArray<Trade>
): Array<Trade> => {
  const fresh: Array<Trade> = []
  for (const t of trades) {
    const seen = last.get(t.symbol)
    if (seen !== undefined && t.tradeNumber <= seen) continue
    last.set(t.symbol, t.tradeNumber)
    fresh.push(t)
  }
  return fresh
}

/** A batch's trades by symbol, each in arrival order. */
export const groupBySymbol = (
  trades: ReadonlyArray<Trade>
): Map<Symbol, Array<Trade>> => {
  const bySymbol = new Map<Symbol, Array<Trade>>()
  for (const t of trades) {
    const group = bySymbol.get(t.symbol)
    if (group) group.push(t)
    else bySymbol.set(t.symbol, [t])
  }
  return bySymbol
}
