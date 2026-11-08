import { Schema } from "effect"

// The IDX ticker of one listed instrument, such as `BBCA`.
export const StockCode = Schema.String.pipe(Schema.brand("StockCode"))
export type StockCode = typeof StockCode.Type

// The code of one index, such as `COMPOSITE`.
export const IndexCode = Schema.String.pipe(Schema.brand("IndexCode"))
export type IndexCode = typeof IndexCode.Type

// What a Day state store is keyed by: a page holds stock codes and indices in
// one map.
export type DayStateCode = StockCode | IndexCode
