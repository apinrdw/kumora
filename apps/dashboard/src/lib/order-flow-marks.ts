// Where the candle and footprint charts mark order flow events (spec
// apinrdw/kumora#605, "Order flow events: on the page"): ▲ above a
// buying-side event's candle, ▼ below a selling-side one's, each with its
// kind's letter. The chart primitive (components/market-live/
// order-flow-marks.ts) only draws them.
import { MINUTE_MS, type Candle, type OrderFlowEvent } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  ORDER_FLOW_LETTERS,
  marketEventKey,
  marketEventKnownAt,
} from "./order-flow-events"

export interface OrderFlowMark {
  readonly event: OrderFlowEvent
  // The event's key (marketEventKey), as the picked event is held.
  readonly key: string
  // The start of the minute it fired on.
  readonly minute: number
  // ▲ above `price` for a buying-side event, ▼ below it for a selling-side.
  readonly above: boolean
  readonly letter: string
  // The minute's candle's high or low, or the event's own price in a minute
  // with no candle (an empty minute's Exhaustion).
  readonly price: number
}

// The marks of `events` known by `until`: an order flow event is known at
// its minute's close (marketEventKnownAt), so a recorded day's cursor shows
// none it hasn't reached.
export const orderFlowMarks = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrderFlowEvent>,
  candles: ReadonlyArray<Candle>,
  until: number
) {
  const byMinute = new Map(
    candles.map((candle) => [DateTime.toEpochMillis(candle.minute), candle])
  )
  const marks: Array<OrderFlowMark> = []
  for (const event of events) {
    if ((yield* marketEventKnownAt(event)) > until) continue
    const minute =
      Math.floor(DateTime.toEpochMillis(event.at) / MINUTE_MS) * MINUTE_MS
    const above = event.side === "buy"
    const candle = byMinute.get(minute)
    marks.push({
      event,
      key: yield* marketEventKey(event),
      minute,
      above,
      letter: ORDER_FLOW_LETTERS[event.kind],
      price:
        candle === undefined ? event.price : above ? candle.high : candle.low,
    })
  }
  return marks
})
