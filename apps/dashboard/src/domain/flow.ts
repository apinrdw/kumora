import { Schema } from "effect"

const FlowPoint = Schema.Struct({
  /** Axis label, unique per point: a session date or a broker code. */
  label: Schema.String,
  /** Net value in Rupiah; positive = net buy. */
  net: Schema.Number,
})
export type FlowPoint = typeof FlowPoint.Type
