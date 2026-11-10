import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// Where a code's Day state came from: Stockbit's `liveprice`, or, while
// Stockbit's feed is lost, the merged tape's regular-board trades and Ajaib's
// `PRICE` carried on from the last `liveprice`.
const DayStateProvenance = Schema.Literals(["Stockbit", "Ajaib"])

// A code's change from the previous close, and it in percent.
const DayChange = Schema.Struct({
  amount: Schema.Finite,
  percent: Schema.Finite,
})
export type DayChange = typeof DayChange.Type

// One stock code's or index's figures for the day so far (spec
// apinrdw/kumora#138, "Day state"). Volume is in lots (an index's shares ÷
// 100), value in rupiah, frequency in trades. The previous close and the
// change from it are absent while no frame of the code has carried a
// previous close (an index's never do), never run from a price seen today.
export const DayState = Schema.Struct({
  code: StockCode,
  last: Schema.Finite,
  previousClose: Schema.optionalKey(Schema.Finite),
  change: Schema.optionalKey(DayChange),
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
