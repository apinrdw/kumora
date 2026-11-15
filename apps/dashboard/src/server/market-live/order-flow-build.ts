// The one-off build of a day sealed before order flow shipped (spec
// apinrdw/kumora#263, "One-off build of sealed days"): its footprint rows
// (cells and sweeps) from its stored trades and its heatmap rows from its
// stored book chunks, the same rows the live day writes (candles.ts,
// book-chunks.ts).
import { Effect } from "effect"
import { type StockCode, MINUTE_MS } from "@workspace/relay"

import type { FootprintRow } from "./candles.ts"
import {
  Fact,
  ORDER_FLOW_BUILT,
  type BuiltMinute,
  type DayStore,
} from "./day-store.ts"
import { addTrade, noCells } from "./footprint-cells.ts"
import { chunkSlices, heldChunkOf } from "./heat-rows.ts"
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
  chunkCodes: ReadonlyArray<StockCode>
) {
  const footprints: Array<FootprintRow> = []
  for (const codeMinute of yield* regroupMinute(
    yield* store.minuteTrades(minute)
  ))
    footprints.push(yield* footprintRow(minute, codeMinute))
  const heatmaps: Array<BuiltMinute["heatmaps"][number]> = []
  for (const code of chunkCodes) {
    const text = yield* store.chunkOfMinute(code, minute)
    if (text === undefined) continue
    heatmaps.push({
      code,
      minute,
      slices: yield* chunkSlices(yield* heldChunkOf(text)),
    })
  }
  return { minute, footprints, heatmaps } satisfies BuiltMinute
})

// Decision: the build goes minute by minute, each minute's whole rows and
// its progress in one transaction, so a build that dies reruns from the
// minute after the last that landed, to the same rows, and holds one
// minute's trades at a time. See spec apinrdw/kumora#263, "One-off build of
// sealed days".
export const buildOrderFlow = Effect.fnUntraced(function* (store: DayStore) {
  const progress = yield* store.fact(Fact.orderFlowBuilt)
  if (progress === ORDER_FLOW_BUILT) return
  const span = yield* store.orderFlowMinutes
  if (span !== undefined) {
    const from =
      progress === undefined
        ? span.first
        : Math.max(span.first, Number(progress) + MINUTE_MS)
    for (let minute = from; minute <= span.last; minute += MINUTE_MS) {
      const built = yield* builtMinute(store, minute, span.chunkCodes)
      if (built.footprints.length > 0 || built.heatmaps.length > 0)
        yield* store.writeBuiltMinute(built)
    }
  }
  yield* store.markOrderFlowBuilt
})

// Whether the day's order flow rows are built, as its object starts.
// Decision: a day that stored nothing yet writes its order flow rows live,
// so it is marked built from the start. Any other day without the mark was
// recorded, whole or in part, before order flow shipped: once sealed, its
// first order flow GET builds the rows. See spec apinrdw/kumora#263,
// "One-off build of sealed days".
export const orderFlowBuiltAtStart = Effect.fnUntraced(function* (
  store: DayStore
) {
  const progress = yield* store.fact(Fact.orderFlowBuilt)
  if (progress === ORDER_FLOW_BUILT) return true
  if (progress !== undefined || !(yield* store.storedNothing)) return false
  yield* store.markOrderFlowBuilt
  return true
})
