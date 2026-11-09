import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// Levels a side the trading-day Durable Object sends: the page shows 10 and
// draws its depth curve from 20 (spec apinrdw/kumora#138, "Order book").
export const BOOK_DEPTH = 20

// One price level: the lots resting there and how many orders hold them.
const BookLevel = Schema.Struct({
  price: Schema.Finite,
  lots: Schema.Finite,
  orders: Schema.Int,
})
export type BookLevel = typeof BookLevel.Type

// One stock code's order book, best level first on each side (highest bid,
// lowest offer), at most BOOK_DEPTH levels a side. The lot totals cover the
// whole book. Provenance is Stockbit `order_book`, or Ajaib
// `ORDER_BOOK_CUSTOM` while Stockbit isn't live. The previous close, when a
// `liveprice` frame carried it, colours the prices.
export const OrderBook = Schema.TaggedStruct("OrderBook", {
  code: StockCode,
  bids: Schema.Array(BookLevel),
  offers: Schema.Array(BookLevel),
  bidLots: Schema.Finite,
  offerLots: Schema.Finite,
  at: Schema.DateTimeUtcFromMillis,
  provenance: Schema.Literals(["Stockbit", "Ajaib"]),
  previousClose: Schema.optionalKey(Schema.Finite),
})
export type OrderBook = typeof OrderBook.Type

// The selected code is an index: it has no order book.
export const IndexHasNoBook = Schema.TaggedStruct("IndexHasNoBook", {
  code: StockCode,
})
export type IndexHasNoBook = typeof IndexHasNoBook.Type
