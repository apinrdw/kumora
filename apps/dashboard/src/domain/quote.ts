import { Schema } from "effect"

const Candle = Schema.Struct({
  /** Axis label, e.g. "14 Okt". */
  label: Schema.String,
  o: Schema.Number,
  h: Schema.Number,
  l: Schema.Number,
  c: Schema.Number,
  /** Shares traded. */
  v: Schema.optionalKey(Schema.Number),
  vwap: Schema.optionalKey(Schema.Number),
})
export type Candle = typeof Candle.Type

const PricePoint = Schema.Struct({
  /** Axis label, unique per point, e.g. "09.15" or "14 Okt". */
  label: Schema.String,
  price: Schema.Number,
  vwap: Schema.optionalKey(Schema.Number),
  /** Shares traded in the interval. */
  volume: Schema.optionalKey(Schema.Number),
})
export type PricePoint = typeof PricePoint.Type
