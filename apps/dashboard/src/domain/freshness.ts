/** How current a figure is. `live` only while a source is delivering. */
export type Freshness =
  | "live"
  | "delayed"
  | "eod"
  | "stale"
  | "unavailable"
  | "demo"
