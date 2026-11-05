import { Schema } from "effect"

/** An ISO 8601 instant in UTC, e.g. 2026-10-23T07:45:00Z. */
export const IsoDateTime = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  ),
  Schema.brand("IsoDateTime")
)
export type IsoDateTime = typeof IsoDateTime.Type

/** Every lookback window any screen offers; each feature picks its subset. */
export const TIMEFRAMES = ["1D", "5D", "1W", "1M", "3M", "1Y"] as const
export const Timeframe = Schema.Literals(TIMEFRAMES)
export type Timeframe = typeof Timeframe.Type
