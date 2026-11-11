import { Schema } from "effect"

/**
 * How current a figure is. `live` only while a source is delivering;
 * `recorded` for a recorded day's replay.
 */
const Freshness = Schema.Literals([
  "live",
  "delayed",
  "eod",
  "stale",
  "unavailable",
  "demo",
  "recorded",
])
export type Freshness = typeof Freshness.Type
