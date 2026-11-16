// Stock codes' IDX-IC sectors (spec apinrdw/kumora#427, "Sectors"): the
// dashboard keeps IDX's company profiles in a table each day and serves them
// at SectorsPath as one map from stock code to sector, which Market Bubbles
// joins to its live codes.
import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// The 11 sectors of IDX-IC as IDX's profiles name them with `lang=en`
// (docs/research/idx-sector-classification.md). Listed Investment Products,
// the twelfth, lists no stocks.
export const IDX_SECTORS = [
  "Energy",
  "Basic Materials",
  "Industrials",
  "Consumer Non-Cyclicals",
  "Consumer Cyclicals",
  "Healthcare",
  "Financials",
  "Properties & Real Estate",
  "Technology",
  "Infrastructures",
  "Transportation & Logistic",
] as const
const Sector = Schema.Literals(IDX_SECTORS)
export type Sector = typeof Sector.Type

// A code with no sector in the map is in this one.
export const UNCLASSIFIED = "Unclassified" as const
export const SectorName = Schema.Union([Sector, Schema.Literal(UNCLASSIFIED)])
export type SectorName = typeof SectorName.Type
export const SectorsPath = "/market-live/sectors"

const SectorMap = Schema.Struct({
  // When the table was last replaced, an ISO instant; null before the first
  // run.
  fetchedAt: Schema.NullOr(Schema.String),
  sectors: Schema.Record(
    StockCode,
    Schema.Struct({ sector: Sector, industry: Schema.String })
  ),
})
export type SectorMap = typeof SectorMap.Type

export const decodeSectorMap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SectorMap)
)
