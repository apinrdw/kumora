import type {
  IndexHasNoBook,
  OrderBook,
  StockCode,
  ViewerDown,
} from "@workspace/relay"

// The selected code's book, word that it is an index, or nothing yet.
export type HeldBook = OrderBook | IndexHasNoBook | undefined

export interface OrderBookStore {
  readonly code: StockCode
  readonly book: () => HeldBook
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: () => void) => () => void
}

// The selected code's order book from the viewer socket, outside React. A
// snapshot replaces it; a delta's book of this code replaces it whole.
export function makeOrderBookStore(code: StockCode): OrderBookStore {
  let held: HeldBook
  const listeners = new Set<() => void>()
  return {
    code,
    book: () => held,
    apply: (message) => {
      const next =
        message._tag === "Snapshot"
          ? message.orderBook
          : message.orderBooks?.find((book) => book.code === code)
      if (message._tag === "Delta" && next === undefined) return
      held = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
