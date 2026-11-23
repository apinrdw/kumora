import { Schema } from "effect"

// Decision: a stock code is capitals, digits and dashes, at most 16 characters
// (packages/relay/docs/adr/0017-a-stock-code-has-one-shape-of-at-most-16-characters.md)
export const STOCK_CODE_MAX_LENGTH = 16

// The stock code of one listed instrument, such as `BBCA`; the three indices
// travel as stock codes too (INDICES).
export const StockCode = Schema.String.check(
  Schema.isPattern(/^(?:[A-Z]{2}\.)?[A-Z0-9-]+$/),
  Schema.isMaxLength(STOCK_CODE_MAX_LENGTH)
).pipe(Schema.brand("StockCode"))
export type StockCode = typeof StockCode.Type

// Decision: the three indices travel as stock codes in every viewer message
// (packages/relay/docs/adr/0018-the-three-indices-travel-as-stock-codes.md)
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
