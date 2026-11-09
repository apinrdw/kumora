import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// Where a code's Day state came from: Stockbit's `liveprice`, or, while
// Stockbit's feed is lost, the merged tape's regular-board trades and Ajaib's
// `PRICE` carried on from the last `liveprice`.
const DayStateProvenance = Schema.Literals(["Stockbit", "Ajaib"])

// One stock code's or index's figures for the day so far (spec
// apinrdw/kumora#138, "Day state"). Volume is in lots (an index's shares ÷
// 100), value in rupiah, frequency in trades; change and change % are from
// the previous close, change % in percent.
export const DayState = Schema.Struct({
  code: StockCode,
  last: Schema.Finite,
  previousClose: Schema.Finite,
  change: Schema.Finite,
  changePercent: Schema.Finite,
  open: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  volume: Schema.Finite,
  value: Schema.Finite,
  frequency: Schema.Finite,
  asOf: Schema.DateTimeUtcFromMillis,
  provenance: DayStateProvenance,
})
export type DayState = typeof DayState.Type
