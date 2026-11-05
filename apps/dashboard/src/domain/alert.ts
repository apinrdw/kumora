import { Schema } from "effect"

import { FeedDependency } from "./freshness"
import { Symbol } from "./symbol"
import { IsoDateTime } from "./time"

export const AlertIndicator = Schema.Literals([
  "net_flow",
  "volume_vs_avg",
  "price_change",
  "confidence",
])
export type AlertIndicator = typeof AlertIndicator.Type

export const AlertOperator = Schema.Literals(["gt", "lt", "gte", "lte"])
export type AlertOperator = typeof AlertOperator.Type

export const AlertSession = Schema.Literals([
  "any",
  "session1",
  "session2",
  "eod",
])
export type AlertSession = typeof AlertSession.Type

export const AlertChannel = Schema.Literals(["inapp", "email"])
export type AlertChannel = typeof AlertChannel.Type

export const AlertRule = Schema.Struct({
  indicator: AlertIndicator,
  operator: AlertOperator,
  /** As typed by the user, e.g. "2,0" or "Rp50 miliar". */
  threshold: Schema.String,
  /** A symbol or a watchlist name. */
  scope: Schema.String,
  session: AlertSession,
  channel: AlertChannel,
  cooldownMin: Schema.Number,
})
export type AlertRule = typeof AlertRule.Type

export const StoredRule = Schema.Struct({
  id: Schema.String,
  rule: AlertRule,
  enabled: Schema.Boolean,
  feed: FeedDependency,
  lastFired: Schema.optionalKey(IsoDateTime),
})
export type StoredRule = typeof StoredRule.Type

export const WatchlistId = Schema.Literals(["utama", "logam", "bank"])
export type WatchlistId = typeof WatchlistId.Type

export const Watchlist = Schema.Struct({
  id: WatchlistId,
  name: Schema.String,
  symbols: Schema.Array(Symbol),
})
export type Watchlist = typeof Watchlist.Type
