import type {
  IndexHasNoBook,
  OrderBook,
  StockCode,
  ViewerDown,
} from "@workspace/relay"
import { Effect } from "effect"

// The selected code's book, word that it is an index, or nothing yet.
export type HeldBook = OrderBook | IndexHasNoBook | undefined

export interface OrderBookStore {
  readonly code: StockCode
  readonly book: () => HeldBook
  readonly apply: (message: ViewerDown) => void
  // A recorded day's frame at the cursor, or none recorded by then.
  readonly replace: (book: HeldBook) => void
  readonly subscribe: (listener: () => void) => () => void
}

// The selected code's order book from the viewer socket, outside React. A
// snapshot of this code replaces it, and one answering an earlier Select of
// another code changes nothing; a delta's book of this code replaces it whole.
export const makeOrderBookStore = (code: StockCode) =>
  Effect.sync((): OrderBookStore => {
    let held: HeldBook
    const listeners = new Set<() => void>()
    const replace = (next: HeldBook) => {
      if (next === held) return
      held = next
      for (const listener of listeners) listener()
    }
    return {
      code,
      book: () => held,
      apply: (message) => {
        if (message._tag === "Snapshot") {
          if (message.selected === code) replace(message.orderBook)
          return
        }
        const next = message.orderBooks?.find((book) => book.code === code)
        if (next !== undefined) replace(next)
      },
      replace,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
