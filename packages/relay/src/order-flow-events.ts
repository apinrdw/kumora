// Order flow events (spec apinrdw/kumora#605, "Order flow events: data"):
// what a code's running trades and one-minute candles did around the day's
// high or low, judged at each minute's close. The trading-day Durable Object
// finds them (dashboard order-flow.ts) and sends them to viewers; the page
// names them in its lib/order-flow-events.ts.
import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// The aggressor side an event is about: buy at the day's high, sell at the
// day's low.
const OrderFlowSide = Schema.Literals(["buy", "sell"])
export type OrderFlowSide = typeof OrderFlowSide.Type

// What every event carries: its code, the start of the minute it was judged
// on, its side, and the price it is about (the extreme or the level).
const common = {
  code: StockCode,
  at: Schema.DateTimeUtcFromMillis,
  side: OrderFlowSide,
  price: Schema.Finite,
}

// The latest minute's side lots (`lots`) against the push's busiest
// minute's (`peakLots`), and its range in ticks against the push's widest.
const Exhaustion = Schema.Struct({
  kind: Schema.Literal("exhaustion"),
  ...common,
  lots: Schema.Finite,
  peakLots: Schema.Finite,
  ticks: Schema.Int,
  widestTicks: Schema.Int,
})

// A new extreme at `price` with cumulative delta `delta` lots, against the
// earlier extreme at `earlierPrice` set on `earlierAt`'s minute with
// `earlierDelta`.
const Divergence = Schema.Struct({
  kind: Schema.Literal("divergence"),
  ...common,
  delta: Schema.Finite,
  earlierAt: Schema.DateTimeUtcFromMillis,
  earlierPrice: Schema.Finite,
  earlierDelta: Schema.Finite,
})

// Trades went to `to` past the level at `price` on `value` rupiah of the
// side's aggressor value beyond it, and a minute closed back inside at
// `close`, `minutes` (0–2) after the breaking minute.
const FailedBreak = Schema.Struct({
  kind: Schema.Literal("failedBreak"),
  ...common,
  to: Schema.Finite,
  value: Schema.Finite,
  close: Schema.Finite,
  minutes: Schema.Int,
})

export const OrderFlowEvent = Schema.Union([
  Exhaustion,
  Divergence,
  FailedBreak,
])
export type OrderFlowEvent = typeof OrderFlowEvent.Type
export type OrderFlowEventKind = OrderFlowEvent["kind"]

// Decision: a snapshot carries the day's newest 100 order flow events
// across every code and the selected code's up to 2,500, as for book events.
// The whole market finds about 1.8 a minute in the open and 0.5 after it. See
// spec apinrdw/kumora#605, "Order flow events: data".
export const SNAPSHOT_ORDER_FLOW_EVENTS = 100
export const MAX_CODE_ORDER_FLOW_EVENTS = 2_500
