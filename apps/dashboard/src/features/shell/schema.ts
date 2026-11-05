import { Schema } from "effect"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"

/** The market-wide figures the shell shows on every page, provenance included. */
export const MarketOverview = Schema.Struct({
  ihsg: Schema.Struct({ last: Schema.Number, changePct: Schema.Number }),
  /** Net foreign flow across the market, Rp. */
  foreignNet: Schema.Number,
  /** Net foreign per Symbol, Rp miliar. */
  netForeignTape: Schema.Array(Schema.Tuple([Symbol, Schema.Number])),
  asOf: IsoDateTime,
})
export type MarketOverview = typeof MarketOverview.Type
