import { Schema } from "effect"

/** Net broker flow in Rupiah from end-of-day data; null when the feed has no coverage. */
export const NetFlow = Schema.NullOr(Schema.Number)
export type NetFlow = typeof NetFlow.Type

export const FlowPoint = Schema.Struct({
  /** Axis label, unique per point: a session date or a broker code. */
  label: Schema.String,
  /** Net value in Rupiah; positive = net buy. */
  net: Schema.Number,
})
export type FlowPoint = typeof FlowPoint.Type

export const BrokerSide = Schema.Literals(["buy", "sell"])
export type BrokerSide = typeof BrokerSide.Type
