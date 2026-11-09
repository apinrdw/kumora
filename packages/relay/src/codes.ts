import { Schema } from "effect"

// The IDX ticker of one listed instrument, such as `BBCA`.
export const StockCode = Schema.String.pipe(Schema.brand("StockCode"))
export type StockCode = typeof StockCode.Type

// The code of one index, such as `COMPOSITE`.
export const IndexCode = Schema.String.pipe(Schema.brand("IndexCode"))
export type IndexCode = typeof IndexCode.Type

// Decision: the three indices travel as stock codes, in a Select, a watchlist
// and every viewer message alike: Stockbit names them in the same `liveprice`
// symbol field (IHSG seen 2026-11-06), and the object tells an index from a
// stock by the frame's `is_index`. The relay subscribes their `liveprice`
// explicitly, since Ajaib's code list has none of them (spec
// apinrdw/kumora#138, "Candles").
export const INDICES: ReadonlyArray<{
  readonly code: StockCode
  readonly name: string
}> = [
  { code: StockCode.make("IHSG"), name: "IDX Composite" },
  // TN: the cash market's board; NG: the negotiated market's.
  { code: StockCode.make("TN.IHSG"), name: "IDX Composite, cash market" },
  { code: StockCode.make("NG.IHSG"), name: "IDX Composite, negotiated market" },
]

export const INDEX_CODES = INDICES.map(({ code }) => code)
