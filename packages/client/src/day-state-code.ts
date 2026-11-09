import type { IndexCode, StockCode } from "@workspace/relay"

// What a Day state store is keyed by: a page holds stock codes and indices in
// one map.
export type DayStateCode = StockCode | IndexCode
