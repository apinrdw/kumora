// A day's broker totals build (spec apinrdw/kumora#437, "Dashboard:
// TradingDay", The build): one ordered pass over the day's held trades, the
// tape's and the walks' fields with their codes, into per-broker totals and
// daily candles for the broker totals DB (src/server/broker-totals/db.ts).
import type { BrokerCode, InvestorType, StockCode } from "@workspace/relay"
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
const KEPT_BOARD = "RG"

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
}

// The side of `code`'s totals for one broker and investor type.
const heldOf = (
  totals: Map<string, Held>,
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

// Decision: lots are summed as whole shares (lots × 100) and value as
// price × shares, so a day's sums are exact integers. See spec
// apinrdw/kumora#437, "The build".
const lotsOf = (shares: number) => shares / 100

// The day's totals and candles, from the store's held trades a page at a
// time, in trade number order.
export const buildBrokerTotals = Effect.fnUntraced(function* (
  brokerCodes: Pick<BrokerCodesStore, "heldTradesPage">
) {
  const totals = new Map<string, Held>()
  const candles = new Map<StockCode, OpenCandle>()
  let after = -1
  for (;;) {
    const page = yield* brokerCodes.heldTradesPage(after)
    if (page === undefined) break
    after = page.last
    for (const trade of page.trades) {
      if (trade.board !== KEPT_BOARD) continue
      const shares = Math.round(trade.lots * 100)
      const value = trade.price * shares
      const { codes } = trade
      const buy = heldOf(totals, trade.code, codes.buyer, codes.buyerType).buy
      buy.shares += shares
      buy.value += value
      const sell = heldOf(
        totals,
        trade.code,
        codes.seller,
        codes.sellerType
      ).sell
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
        })
      else {
        candle.high = Math.max(candle.high, trade.price)
        candle.low = Math.min(candle.low, trade.price)
        candle.close = trade.price
        candle.shares += shares
        candle.value += value
      }
    }
  }
  return {
    totals: [...totals.values()].map((held): BrokerTotal => ({
      code: held.code,
      broker: held.broker,
      investorType: held.investorType,
      buyLots: lotsOf(held.buy.shares),
      buyValue: held.buy.value,
      sellLots: lotsOf(held.sell.shares),
      sellValue: held.sell.value,
    })),
    candles: [...candles.values()].map((candle): DayCandle => ({
      code: candle.code,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: lotsOf(candle.shares),
      value: candle.value,
    })),
  } satisfies DayBuild
})
