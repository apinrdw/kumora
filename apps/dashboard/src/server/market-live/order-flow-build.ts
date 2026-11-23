// The one-off build of a day sealed before order flow shipped (spec
// apinrdw/kumora#263, "One-off build of sealed days"): its footprint rows
// (cells and sweeps) from its stored trades, the same rows the live day
// writes (candles.ts). A walked day's build writes its candles as well. Its
// heatmap is worked out from its book chunks on read (day-store.ts,
// `heatmapOf`).
import { Effect } from "effect"
import { MINUTE_MS } from "@workspace/relay"

import {
  figuresOfTrades,
  type FootprintRow,
  type StoredCandle,
} from "./candles.ts"
import {
  Fact,
  ORDER_FLOW_BUILT,
  type BuiltMinute,
  type DayStore,
} from "./day-store.ts"
import { addTrade, noCells } from "./footprint-cells.ts"
import { regroupMinute, type CodeMinute } from "./minute-regroup.ts"

// One stock's footprint row from its trades and sweeps in one minute.
const footprintRow = Effect.fnUntraced(function* (
  minute: number,
  { code, trades, sweeps }: CodeMinute
) {
  const cells = yield* noCells
  let lastTrade = -1n
  for (const trade of trades) {
    yield* addTrade(cells, trade)
    const number = BigInt(trade.tradeNumber)
    if (number > lastTrade) lastTrade = number
  }
  return { code, minute, cells, sweeps, lastTrade } satisfies FootprintRow
})

const builtMinute = Effect.fnUntraced(function* (
  store: DayStore,
  minute: number,
  withCandles: boolean
) {
  const footprints: Array<FootprintRow> = []
  const candles: Array<StoredCandle> = []
  for (const codeMinute of yield* regroupMinute(
    yield* store.minuteTrades(minute)
  )) {
    footprints.push(yield* footprintRow(minute, codeMinute))
    const figures = withCandles
      ? yield* figuresOfTrades(codeMinute.trades)
      : undefined
    if (figures !== undefined)
      candles.push({ code: codeMinute.code, minute, figures })
  }
  return { minute, candles, footprints } satisfies BuiltMinute
})

// The build goes minute by minute, each minute's whole rows and
// its progress in one transaction, so a build that dies reruns from the
// minute after the last that landed, to the same rows, and holds one
// minute's trades at a time. See spec apinrdw/kumora#263, "One-off build of
// sealed days".
export const buildOrderFlow = Effect.fnUntraced(function* (store: DayStore) {
  const progress = yield* store.fact(Fact.orderFlowBuilt)
  if (progress === ORDER_FLOW_BUILT) return
  yield* buildFrom(
    store,
    progress === undefined ? undefined : Number(progress) + MINUTE_MS,
    false
  )
})

// Every minute's rows from `from` (the day's first when undefined) on, then
// the mark that they are built.
const buildFrom = Effect.fnUntraced(function* (
  store: DayStore,
  from: number | undefined,
  withCandles: boolean
) {
  const span = yield* store.orderFlowMinutes
  if (span !== undefined)
    for (
      let minute = Math.max(span.first, from ?? span.first);
      minute <= span.last;
      minute += MINUTE_MS
    ) {
      const built = yield* builtMinute(store, minute, withCandles)
      if (built.footprints.length > 0) yield* store.writeBuiltMinute(built)
    }
  yield* store.markOrderFlowBuilt
})

// A walked day's candles, footprints and sweeps are built from its
// tape at its seal, from its first minute, as the one-off build goes: its
// trades came out of time order, so the candle book would reread a stored
// minute for nearly each. A seal that dies rebuilds it whole, to the same
// rows. See spec apinrdw/kumora#437, "A History walk day becomes a recorded day".
export const buildWalkedDay = (store: DayStore) =>
  buildFrom(store, undefined, true)

// Whether the day's order flow rows are built, as its object starts.
// Decision: an empty day is marked built; an older one builds on its first GET
// (apps/dashboard/docs/adr/0091-order-flow-rows-build-live-older-days-on-first-get.md)
export const orderFlowBuiltAtStart = Effect.fnUntraced(function* (
  store: DayStore
) {
  const progress = yield* store.fact(Fact.orderFlowBuilt)
  if (progress === ORDER_FLOW_BUILT) return true
  if (progress !== undefined || !(yield* store.storedNothing)) return false
  yield* store.markOrderFlowBuilt
  return true
})
