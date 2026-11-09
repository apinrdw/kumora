/**
 * How current a figure is. `live` only while a source is delivering;
 * `recorded` for a recorded day's replay.
 */
export type Freshness =
  | "live"
  | "delayed"
  | "eod"
  | "stale"
  | "unavailable"
  | "demo"
  | "recorded"
