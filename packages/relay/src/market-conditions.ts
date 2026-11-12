import { Schema } from "effect"

import { StockCode } from "./codes.ts"
import { MarketPhase } from "./schedule.ts"

// How current one feed is, as the trading-day Durable Object decides it for
// every viewer (spec apinrdw/kumora#138, "Feed freshness"). Delayed is
// arriving, but with a feed lag far behind the exchange (spec
// apinrdw/kumora#235, "Feed health").
const Freshness = Schema.Literals(["live", "delayed", "stale", "unavailable"])
export type Freshness = typeof Freshness.Type

// A stretch that expects trades in which neither feed was live, or the relay
// was offline. One still open has no end.
export const RelayGap = Schema.Struct({
  from: Schema.DateTimeUtcFromMillis,
  to: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
})
export type RelayGap = typeof RelayGap.Type

// The market conditions: the market phase, each feed's freshness and the
// relay gaps so far. Sent in every snapshot, and in a delta whenever any of
// it changed.
export const MarketConditions = Schema.Struct({
  phase: MarketPhase,
  // When the market next opens (08:45 WIB of the next trading day). Absent
  // while it is open, or past the baked schedule.
  nextOpen: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
  // False when no relay is connected: both feeds read unavailable, for that
  // reason rather than a broker socket dropping.
  relayOnline: Schema.Boolean,
  feeds: Schema.Struct({ Stockbit: Freshness, Ajaib: Freshness }),
  // Each delayed feed's feed lag in ms, its last reading as the trading day
  // judges it (apps/dashboard feed-health.ts). Absent while no feed is
  // delayed.
  lags: Schema.optionalKey(
    Schema.Struct({
      Stockbit: Schema.optionalKey(Schema.Finite),
      Ajaib: Schema.optionalKey(Schema.Finite),
    })
  ),
  gaps: Schema.Array(RelayGap),
})
export type MarketConditions = typeof MarketConditions.Type

// One code's indicative (auction equilibrium) price and volume in shares,
// from Stockbit `iepiev`, or Ajaib `INDICATIVE` while Stockbit isn't live.
export const IndicativePrice = Schema.Struct({
  code: StockCode,
  price: Schema.Finite,
  volume: Schema.Finite,
  at: Schema.DateTimeUtcFromMillis,
})
export type IndicativePrice = typeof IndicativePrice.Type
