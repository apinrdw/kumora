import { Schema } from "effect"

import { NetFlow } from "./flow"

/** The full trading state of an instrument for the current session. */
export const Quote = Schema.Struct({
  last: Schema.Number,
  prev: Schema.Number,
  open: Schema.Number,
  high: Schema.Number,
  low: Schema.Number,
  avg: Schema.Number,
  volumeLot: Schema.Number,
  /** Rupiah. */
  value: Schema.Number,
  freq: Schema.Number,
})
export type Quote = typeof Quote.Type

/** The compact quote shown in lists. */
export const QuoteSummary = Schema.Struct({
  last: Schema.Number,
  /** Rupiah change vs previous close. */
  change: Schema.Number,
  changePct: Schema.Number,
  /** Shares traded today. */
  volume: Schema.Number,
  vwap: Schema.Number,
  /** Latest end-of-day net flow; null without broker history. */
  netFlowEod: NetFlow,
})
export type QuoteSummary = typeof QuoteSummary.Type

export const Candle = Schema.Struct({
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

export const PricePoint = Schema.Struct({
  /** Axis label, unique per point, e.g. "09.15" or "14 Okt". */
  label: Schema.String,
  price: Schema.Number,
  vwap: Schema.optionalKey(Schema.Number),
  /** Shares traded in the interval. */
  volume: Schema.optionalKey(Schema.Number),
})
export type PricePoint = typeof PricePoint.Type
