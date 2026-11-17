// A day's broker totals build (spec apinrdw/kumora#437, "Dashboard:
// TradingDay", The build): one ordered pass over the day's held trades, the
// tape's and the walks' fields with their codes, into per-broker totals and
// daily candles for the broker totals DB (src/server/broker-totals/db.ts).
import {
  type BrokerCode,
  type InvestorType,
  type RunningTrade,
  SHARES_PER_LOT,
  type StockCode,
} from "@workspace/relay"
import { Effect } from "effect"

import type { BrokerTotal, DayBuild, DayCandle } from "../broker-totals/db.ts"
import type { BrokerCodesStore } from "./broker-codes.ts"

// Decision: each built day records the version that built it; a change to
// what the build makes bumps it, and the reconcile rebuilds older days at
// its pace. See apinrdw/kumora#420.
export const BROKER_TOTALS_VERSION = 1

// The broker totals fact of a sealed, complete day not built yet.
export const BROKER_TOTALS_DUE = "due"

// The broker totals fact of a built day a later batch corrected, to rebuild
// once its corrections go quiet.
export const BROKER_TOTALS_STALE = "stale"

// Decision: the build keeps the regular board, which holds the auction
// matches too; negotiated (NG) and cash (TN) trades count in neither totals
// nor candles. See spec apinrdw/kumora#437, "The build".
const KEPT_BOARD = "RG" satisfies RunningTrade["board"]

interface Side {
  shares: number
  value: number
}

interface Held {
  readonly code: StockCode
  readonly broker: BrokerCode
  readonly investorType: InvestorType
  readonly buy: Side
  readonly sell: Side
}

interface OpenCandle {
  readonly code: StockCode
  readonly open: number
  high: number
  low: number
  close: number
  shares: number
  value: number
  trades: number
}

// Decision: lots are summed as whole shares (lots × SHARES_PER_LOT) and
// value as price × shares, so a day's sums are exact integers. See spec
// apinrdw/kumora#437, "The build".
const lotsOf = (shares: number) => Effect.succeed(shares / SHARES_PER_LOT)

// The day's totals and candles, from the store's held trades a page at a
// time, in trade number order.
// Decision: the build holds one page of trades and one entry per (code,
// broker, investor type) and per code, never the day's trades, so its
// memory is bounded by codes × brokers. At the largest day the store
// accepts, 1.5M trades over 900 codes and 90 brokers, it held about 15 MB
// (broker-totals-memory.test.ts).
export const buildBrokerTotals = Effect.fnUntraced(function* (
  brokerCodes: Pick<BrokerCodesStore, "heldTradesPage">
) {
  const totals = new Map<string, Held>()
  const candles = new Map<StockCode, OpenCandle>()
  // The side of `code`'s totals for one broker and investor type.
  const heldOf = (
    code: StockCode,
    broker: BrokerCode,
    investorType: InvestorType
  ) => {
    const key = `${code} ${broker} ${investorType}`
    const held = totals.get(key)
    if (held !== undefined) return held
    const made: Held = {
      code,
      broker,
      investorType,
      buy: { shares: 0, value: 0 },
      sell: { shares: 0, value: 0 },
    }
    totals.set(key, made)
    return made
  }
  let after = -1
  for (;;) {
    const page = yield* brokerCodes.heldTradesPage(after)
    if (page === undefined) break
    after = page.last
    for (const trade of page.trades) {
      if (trade.board !== KEPT_BOARD) continue
      const shares = Math.round(trade.lots * SHARES_PER_LOT)
      const value = trade.price * shares
      const { codes } = trade
      const buy = heldOf(trade.code, codes.buyer, codes.buyerType).buy
      buy.shares += shares
      buy.value += value
      const sell = heldOf(trade.code, codes.seller, codes.sellerType).sell
      sell.shares += shares
      sell.value += value
      const candle = candles.get(trade.code)
      if (candle === undefined)
        candles.set(trade.code, {
          code: trade.code,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          shares,
          value,
          trades: 1,
        })
      else {
        candle.high = Math.max(candle.high, trade.price)
        candle.low = Math.min(candle.low, trade.price)
        candle.close = trade.price
        candle.shares += shares
        candle.value += value
        candle.trades++
      }
    }
  }
  const built: {
    totals: Array<BrokerTotal>
    candles: Array<DayCandle>
  } = { totals: [], candles: [] }
  for (const held of totals.values())
    built.totals.push({
      code: held.code,
      broker: held.broker,
      investorType: held.investorType,
      buyLots: yield* lotsOf(held.buy.shares),
      buyValue: held.buy.value,
      sellLots: yield* lotsOf(held.sell.shares),
      sellValue: held.sell.value,
    })
  for (const candle of candles.values())
    built.candles.push({
      code: candle.code,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: yield* lotsOf(candle.shares),
      value: candle.value,
      trades: candle.trades,
    })
  return built satisfies DayBuild
})
