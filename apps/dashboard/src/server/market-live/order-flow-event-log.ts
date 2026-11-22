// The day's order flow events (spec apinrdw/kumora#605, "Order flow events:
// data"): what the order flow rules found, held for the next delta, the next
// flush and the snapshots (event-log.ts).
import {
  MAX_CODE_ORDER_FLOW_EVENTS,
  EventOrder,
  SNAPSHOT_ORDER_FLOW_EVENTS,
} from "@workspace/relay"

import type { DayStore } from "./day-store.ts"
import { makeEventLog } from "./event-log.ts"

// Decision: while flushes keep failing, memory holds at most 20,000 order
// flow events not stored yet (about 4 MB on node) and drops the oldest past
// that. The replay of five recorded days found 3,503 a day across the market
// (docs/research/order-flow-event-thresholds.md), before the push minimum
// cut Exhaustion by two thirds. See spec apinrdw/kumora#605, "data".
const MAX_UNFLUSHED_ORDER_FLOW_EVENTS = 20_000

export const makeOrderFlowEventLog = (
  store: Pick<DayStore, "orderFlowEventsOf" | "storedOrderFlowEvents">
) =>
  makeEventLog({
    order: EventOrder,
    snapshot: SNAPSHOT_ORDER_FLOW_EVENTS,
    perCode: MAX_CODE_ORDER_FLOW_EVENTS,
    maxUnflushed: MAX_UNFLUSHED_ORDER_FLOW_EVENTS,
    storedNewest: store.storedOrderFlowEvents,
    storedOf: store.orderFlowEventsOf,
  })
