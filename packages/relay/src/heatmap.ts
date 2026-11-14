// The book heatmap (spec apinrdw/kumora#263, "The trading-day Durable
// Object" and "Viewer protocol"): a stock code's order book over the day as
// 10-second slices of the time-weighted resting lots at each price, bid and
// offer apart. The page draws them behind chart 1's candles.
import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// The length of one slice: six to a minute.
export const HEAT_SLICE_MS = 10_000

// One price's average resting lots over a slice: [price, bid lots, offer
// lots].
const HeatLevel = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])
export type HeatLevel = typeof HeatLevel.Type

// One slice: its start, and its levels ascending by price. A price with no
// lots on either side over the whole slice is left out.
const HeatSlice = Schema.Struct({
  at: Schema.DateTimeUtcFromMillis,
  levels: Schema.Array(HeatLevel),
})
export type HeatSlice = typeof HeatSlice.Type

// One code's slices of the day, ascending, every one that starts before
// `through` and none from it. A live page builds the slices from `through` on
// out of the order books its deltas carry, so the two meet with no gap and no
// overlap. A slice with no book is left out; a minute with no frame keeps the
// book before it, and a sealed day's `through` is where the relay's streaming
// ended.
const RecordedHeatmap = Schema.Struct({
  code: StockCode,
  through: Schema.DateTimeUtcFromMillis,
  slices: Schema.Array(HeatSlice),
})
export type RecordedHeatmap = typeof RecordedHeatmap.Type

export const encodeRecordedHeatmap = Schema.encodeEffect(
  Schema.fromJsonString(RecordedHeatmap)
)
export const decodeRecordedHeatmap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecordedHeatmap)
)
