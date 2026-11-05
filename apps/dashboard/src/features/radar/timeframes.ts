import type { Timeframe } from "@/domain/time"

/** Kept apart from `schema.ts` so client code can read it without `effect`. */
export const RADAR_TIMEFRAMES = [
  "1D",
  "5D",
  "1M",
] as const satisfies ReadonlyArray<Timeframe>
