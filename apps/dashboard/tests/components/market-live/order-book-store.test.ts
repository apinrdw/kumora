import { StockCode, type OrderBook, type ViewerDown } from "@workspace/relay"
import { DateTime } from "effect"
import { describe, expect, test } from "vitest"

import { makeOrderBookStore } from "@/components/market-live/order-book-store"

const book = (code: string, price: number): OrderBook => ({
  _tag: "OrderBook",
  code: StockCode.make(code),
  bids: [{ price, lots: 1, orders: 1 }],
  offers: [],
  bidLots: 1,
  offerLots: 0,
  at: DateTime.makeUnsafe("2026-11-09T09:00:00+07:00"),
  provenance: "Stockbit",
})

// The snapshot answering a Select of `selected`.
const snapshot = (selected: string, orderBook: OrderBook): ViewerDown => ({
  _tag: "Snapshot",
  selected: StockCode.make(selected),
  tape: [],
  candles: [],
  orderBook,
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
})

describe("the selected code's order book", () => {
  test("a snapshot answering an earlier Select of another code changes nothing; this code's replaces it", () => {
    const store = makeOrderBookStore(StockCode.make("BBRI"))
    let heard = 0
    store.subscribe(() => heard++)
    // The page moved from BBCA to BBRI before BBCA's snapshot arrived.
    store.apply(snapshot("BBCA", book("BBCA", 9_000)))
    expect(store.book()).toBeUndefined()
    expect(heard).toBe(0)
    store.apply(snapshot("BBRI", book("BBRI", 4_000)))
    expect(store.book()).toEqual(book("BBRI", 4_000))
    expect(heard).toBe(1)
  })
})
