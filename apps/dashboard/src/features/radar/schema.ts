import { Schema } from "effect"

import { NetFlow } from "@/domain/flow"
import { PricePoint } from "@/domain/quote"
import {
  AIInput,
  Confidence,
  Contribution,
  Evidence,
  Signal,
} from "@/domain/signal"
import { Liquidity, Sector, Symbol } from "@/domain/symbol"
import { WhalesToday } from "@/domain/trade"
import { IsoDateTime } from "@/domain/time"
import { RADAR_TIMEFRAMES } from "./timeframes"

export const RadarTimeframe = Schema.Literals(RADAR_TIMEFRAMES)
export type RadarTimeframe = typeof RadarTimeframe.Type

export const Candidate = Schema.Struct({
  symbol: Symbol,
  name: Schema.String,
  sector: Sector,
  liquidity: Liquidity,
  last: Schema.Number,
  /** Δ% per timeframe; 5D and 1M are derived from `history`. */
  change: Schema.Record(RadarTimeframe, Schema.Number),
  /** Today's volume divided by the 20-session average. */
  volx: Schema.Number,
  /** Net broker flow (EOD), Rp. null when the feed has no coverage. */
  flow: NetFlow,
  ai: Signal,
  /** Pattern-classification certainty 0–100, never a probability of profit. */
  confidence: Schema.NullOr(Confidence),
  updated: IsoDateTime,
  hypothesis: Schema.String,
  evidence: Schema.Array(Evidence),
  counter: Schema.Array(Schema.String),
  contributions: Schema.Array(Contribution),
  /** Last 20 daily sessions, oldest first. */
  history: Schema.Array(PricePoint),
})
export type Candidate = typeof Candidate.Type

/** The radar page's read model, provenance included. */
export const RadarSnapshot = Schema.Struct({
  candidates: Schema.Array(Candidate),
  aiInputs: Schema.Array(AIInput),
  aiLimitations: Schema.Array(Schema.String),
  asOf: IsoDateTime,
  brokerAsOf: IsoDateTime,
  computedAt: IsoDateTime,
  modelVersion: Schema.String,
  /** Today's sweeps. The candidates above stay on demo data. */
  whales: WhalesToday,
})
export type RadarSnapshot = typeof RadarSnapshot.Type
