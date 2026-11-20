// The day's order flow events (spec apinrdw/kumora#605, "Order flow events:
// data"): what the order flow rules found, held for the next delta and the
// snapshots. Memory holds the day's, at most MAX_DAY_ORDER_FLOW_EVENTS.
import {
  MAX_CODE_ORDER_FLOW_EVENTS,
  OrderFlowEventOrder,
  SNAPSHOT_ORDER_FLOW_EVENTS,
  type OrderFlowEvent,
  type StockCode,
} from "@workspace/relay"
import { Array as Arr, Effect } from "effect"

// Decision: memory holds at most 20,000 of the day's order flow events
// (about 4 MB on node) and drops the oldest past that. The replay of five
// recorded days found 3,503 a day across the market (docs/research/
// order-flow-event-thresholds.md), before the push minimum cut Exhaustion by
// two thirds. See spec apinrdw/kumora#605, "Order flow events: data".
const MAX_DAY_ORDER_FLOW_EVENTS = 20_000

export const makeOrderFlowEventLog = Effect.sync(() => {
  let day: Array<OrderFlowEvent> = []
  let pending: Array<OrderFlowEvent> = []

  const add = (events: ReadonlyArray<OrderFlowEvent>) =>
    Effect.sync(() => {
      if (events.length === 0) return
      pending.push(...events)
      day = Arr.sort([...day, ...events], OrderFlowEventOrder)
      if (day.length > MAX_DAY_ORDER_FLOW_EVENTS)
        day = day.slice(-MAX_DAY_ORDER_FLOW_EVENTS)
    })

  // The events found since the last delta.
  const takeDelta = Effect.sync(() => {
    const taken = pending
    pending = []
    return taken
  })

  // The day's newest SNAPSHOT_ORDER_FLOW_EVENTS across every code, oldest
  // first.
  const newest = Effect.sync(() => day.slice(-SNAPSHOT_ORDER_FLOW_EVENTS))

  // One code's newest MAX_CODE_ORDER_FLOW_EVENTS of the day, oldest first.
  const ofCode = (code: StockCode) =>
    Effect.sync(() =>
      day
        .filter((event) => event.code === code)
        .slice(-MAX_CODE_ORDER_FLOW_EVENTS)
    )

  return { add, takeDelta, newest, ofCode }
})
