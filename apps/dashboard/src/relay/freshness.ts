import type { IsoDateTime } from "@/domain/time"
import type { StaleReason, TradeSource } from "@/domain/trade"

import type { Phase } from "./calendar"

/** How recent the last frame must be to read as live, for a feed or for one symbol's `receiving`. */
export const LIVE_MS = 60_000

export type RelayFreshness =
  | { readonly freshness: "live"; readonly reason: null }
  | { readonly freshness: "stale"; readonly reason: StaleReason }

const staleReason = (source: TradeSource, phase: Phase): StaleReason => {
  if (phase === "closed") return "closed"
  if (phase === "break") return "break"
  return source === "none" ? "no-source" : "no-trades"
}

/**
 * Live while a source is active and the relay took any trade in the last 60 s,
 * whatever the calendar says. The 60 s is over the whole feed, not one symbol.
 */
export const relayFreshness = (
  now: number,
  lastTradeAt: IsoDateTime | null,
  source: TradeSource,
  phase: Phase
): RelayFreshness =>
  source !== "none" &&
  lastTradeAt !== null &&
  now - Date.parse(lastTradeAt) < LIVE_MS
    ? { freshness: "live", reason: null }
    : { freshness: "stale", reason: staleReason(source, phase) }
