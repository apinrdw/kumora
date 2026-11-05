import { Schema } from "effect"

/**
 * How current a figure is. `live` only while the relay's active source is delivering.
 * `FRESHNESS` in apps/stockbit-relay-extension/src/protocol.ts is a copy, and names this.
 */
export const Freshness = Schema.Literals([
  "live",
  "delayed",
  "eod",
  "stale",
  "unavailable",
  "demo",
])
export type Freshness = typeof Freshness.Type

/** Which kind of feed a figure or rule relies on. */
export const FeedDependency = Schema.Literals(["eod", "delayed", "live"])
export type FeedDependency = typeof FeedDependency.Type
