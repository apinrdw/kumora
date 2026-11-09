import { Schema } from "effect"

import { StockCode } from "./codes.ts"
import { MarketPhase } from "./schedule.ts"

// How current one feed is, as the trading-day Durable Object decides it for
// every viewer (spec apinrdw/kumora#138, "Feed freshness").
const Freshness = Schema.Literals(["live", "stale", "unavailable"])
export type Freshness = typeof Freshness.Type

// A stretch that expects trades in which neither feed was live, or the relay
// was offline. One still open has no end.
export const RelayGap = Schema.Struct({
  from: Schema.DateTimeUtcFromMillis,
  to: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
})
export type RelayGap = typeof RelayGap.Type

// The market phase, each feed's freshness and the relay gaps so far. Sent in
// every snapshot, and in a delta whenever any of it changed.
export const MarketStatus = Schema.Struct({
  phase: MarketPhase,
  // When the market next opens (08:45 WIB of the next trading day). Absent
  // while it is open, or past the baked schedule.
  nextOpen: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
  // False when no relay is connected: both feeds read unavailable, for that
  // reason rather than a broker socket dropping.
  relayOnline: Schema.Boolean,
  feeds: Schema.Struct({ Stockbit: Freshness, Ajaib: Freshness }),
  gaps: Schema.Array(RelayGap),
})
export type MarketStatus = typeof MarketStatus.Type

// One code's indicative (auction equilibrium) price and volume in shares,
// from Stockbit `iepiev`, or Ajaib `INDICATIVE` while Stockbit isn't live.
export const IndicativePrice = Schema.Struct({
  code: StockCode,
  price: Schema.Finite,
  volume: Schema.Finite,
  at: Schema.DateTimeUtcFromMillis,
})
export type IndicativePrice = typeof IndicativePrice.Type
