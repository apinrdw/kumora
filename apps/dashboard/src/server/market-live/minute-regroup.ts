// One stored minute regrouped by stock code (spec apinrdw/kumora#263, "One-off
// build of sealed days", and spec apinrdw/kumora#343, "The TradingDay sweep
// brokers table"): the tape has no code index, so both the order-flow
// build and the sweep brokers recompute read the whole market's minute and
// split it by code here, each code's sweeps grouped as its footprint row's.
import {
  sweepsOf,
  type RunningTrade,
  type StockCode,
  type Sweep,
} from "@workspace/relay"
import { Effect } from "effect"

// One code's regular-board trades in a minute, ascending by trade number,
// and the sweeps they group into.
export interface CodeMinute {
  readonly code: StockCode
  readonly trades: ReadonlyArray<RunningTrade>
  readonly sweeps: ReadonlyArray<Sweep>
}

// A minute's trades of every code (the day store's `minuteTrades`), by code.
export const regroupMinute = Effect.fnUntraced(function* (
  trades: ReadonlyArray<RunningTrade>
) {
  const byCode = new Map<StockCode, Array<RunningTrade>>()
  for (const trade of trades) {
    const held = byCode.get(trade.code) ?? []
    held.push(trade)
    byCode.set(trade.code, held)
  }
  const codes: Array<CodeMinute> = []
  for (const [code, held] of byCode)
    codes.push({ code, trades: held, sweeps: yield* sweepsOf(held) })
  return codes
})
