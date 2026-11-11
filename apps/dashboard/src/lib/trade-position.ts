// Where a trade number sits in a list kept ascending by trade number: the
// server's tape and Day state, and the page's tape, insert and look up by it.
import { TradeNumberOrder, type TradeNumber } from "@workspace/relay"
import { Effect } from "effect"

// The index in `items` where `number` sits, or would be inserted.
export const tradePosition = <T extends { readonly tradeNumber: TradeNumber }>(
  items: ReadonlyArray<T>,
  number: TradeNumber
) =>
  Effect.sync(() => {
    let low = 0
    let high = items.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (TradeNumberOrder(items[middle]!.tradeNumber, number) < 0)
        low = middle + 1
      else high = middle
    }
    return low
  })
