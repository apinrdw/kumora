import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// The shares in one IDX lot.
export const SHARES_PER_LOT = 100

// What `lots` at `price` are worth in rupiah: a level's value, a wall's, or a
// trade's.
// Decision: plain, not an Effect: the level ledger and the book readings call
// it for every level of every side frame (level-ledger.ts's Decision gives
// the timing).
export const levelValue = (price: number, lots: number) =>
  price * lots * SHARES_PER_LOT

// Levels a side the trading-day Durable Object sends: the page shows 10 and
// draws its depth curve from 20 (spec apinrdw/kumora#138, "Order book").
export const BOOK_DEPTH = 20

// One price level: the lots resting there and how many orders hold them.
export const BookLevel = Schema.Struct({
  price: Schema.Finite,
  lots: Schema.Finite,
  orders: Schema.Int,
})
export type BookLevel = typeof BookLevel.Type

// One stock code's order book, best level first on each side (highest bid,
// lowest offer), at most BOOK_DEPTH levels a side. The lot totals cover the
// whole book. Provenance is Stockbit `order_book`, or Ajaib
// `ORDER_BOOK_CUSTOM` while Stockbit isn't live. The previous close, when a
// `liveprice` frame carried it, colours the prices. `at` is the later of the
// two sides' times. A side no frame has set yet, and every book stored before
// the per-side fields, has none of them: its time is `at`.
// Decision: each side keeps its own frame's time and, from Stockbit, its
// `sequence_number`, which orders a code's two sides even when their times
// tie. A sequence has gaps and can arrive out of order, so a gap never means a
// lost frame. See spec apinrdw/kumora#517, "Data".
export const BookSideFields = {
  bidAt: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
  offerAt: Schema.optionalKey(Schema.DateTimeUtcFromMillis),
  bidSequence: Schema.optionalKey(Schema.Int),
  offerSequence: Schema.optionalKey(Schema.Int),
}

export const OrderBook = Schema.TaggedStruct("OrderBook", {
  code: StockCode,
  bids: Schema.Array(BookLevel),
  offers: Schema.Array(BookLevel),
  bidLots: Schema.Finite,
  offerLots: Schema.Finite,
  at: Schema.DateTimeUtcFromMillis,
  ...BookSideFields,
  provenance: Schema.Literals(["Stockbit", "Ajaib"]),
  previousClose: Schema.optionalKey(Schema.Finite),
})
export type OrderBook = typeof OrderBook.Type

// The selected code is an index: it has no order book.
export const IndexHasNoBook = Schema.TaggedStruct("IndexHasNoBook", {
  code: StockCode,
})
export type IndexHasNoBook = typeof IndexHasNoBook.Type
