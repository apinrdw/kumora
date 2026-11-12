import { Schema } from "effect"

// Decision: a stock code is capitals, digits and dashes (`BBCA`, `BUMI-W2`),
// optionally after a two-letter board and a dot (`TN.IHSG`), at most 16
// characters (the longest listed is 10); every decoder shares this one shape.
// The trading-day object's storage and the watchlist cap (envelope.ts) count
// on the length. See apinrdw/kumora#157.
const STOCK_CODE_MAX_LENGTH = 16

// The stock code of one listed instrument, such as `BBCA`; the three indices
// travel as stock codes too (INDICES).
export const StockCode = Schema.String.check(
  Schema.isPattern(/^(?:[A-Z]{2}\.)?[A-Z0-9-]+$/),
  Schema.isMaxLength(STOCK_CODE_MAX_LENGTH)
).pipe(Schema.brand("StockCode"))
export type StockCode = typeof StockCode.Type

// Decision: the three indices travel as stock codes in every viewer message:
// Stockbit names them in the same `liveprice` symbol field, and the object
// tells an index by the frame's `is_index`. The relay subscribes them
// explicitly, since Ajaib's code list has none. See spec apinrdw/kumora#138,
// "Candles".
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
