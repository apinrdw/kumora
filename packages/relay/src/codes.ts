import { Schema } from "effect"

// Decision: a stock code is capitals, digits and dashes (`BBCA`, `BUMI-W2`,
// `R-LQ45X`), or those after a two-letter board and a dot (`TN.IHSG`), at
// most 16 characters: the longest Ajaib lists is a structured warrant's 10
// (`ADRODRCM3A`, the 2026-11-09 capture) and the longest index code 7. This
// is the one definition of a code's shape, checked wherever one is decoded:
// a viewer's Select, the page's URL, both feeds' frames and Ajaib's list. The
// trading-day object's storage decision (trading-day-object.ts) and the
// watchlist cap (envelope.ts) count on the length.
const STOCK_CODE_MAX_LENGTH = 16

// The stock code of one listed instrument, such as `BBCA`; the three indices
// travel as stock codes too (INDICES).
export const StockCode = Schema.String.check(
  Schema.isPattern(/^(?:[A-Z]{2}\.)?[A-Z0-9-]+$/),
  Schema.isMaxLength(STOCK_CODE_MAX_LENGTH)
).pipe(Schema.brand("StockCode"))
export type StockCode = typeof StockCode.Type

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
