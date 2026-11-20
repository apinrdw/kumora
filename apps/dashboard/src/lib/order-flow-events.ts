// How the page names order flow events (spec apinrdw/kumora#605, "Order flow
// events: the rules" and "on the page"): each kind's letter, title and
// figures line. The scanner's feed and chips and the Book readout list show
// them with book events, as one kind of row.
import {
  MINUTE_MS,
  WibDate,
  type BookEvent,
  type OrderFlowEvent,
  type OrderFlowEventKind,
} from "@workspace/relay"
import { DateTime, Effect, Order } from "effect"

import { BOOK_EVENT_NAMES, bookEventDetail, bookEventKey } from "./book-events"
import { plain, signed, wibClock } from "./format"

// The events the radar and the readout list: a book event or an order flow
// event, told apart by `kind`.
export type MarketEvent = BookEvent | OrderFlowEvent

// Market events oldest first, by their time.
export const MarketEventOrder: Order.Order<MarketEvent> = Order.mapInput(
  Order.Number,
  (event: MarketEvent) => DateTime.toEpochMillis(event.at)
)

// Decision: the first day the trading-day object records order flow events,
// named on an earlier day's readout. Its GET says whether a day kept them;
// this date is only the copy, set to the day they ship. See spec
// apinrdw/kumora#605, "Order flow events: data".
export const ORDER_FLOW_EVENTS_FROM = WibDate.make("2026-11-23")

// The letter beside each kind's ▲/▼ mark.
export const ORDER_FLOW_LETTERS: Readonly<Record<OrderFlowEventKind, string>> =
  {
    exhaustion: "E",
    divergence: "D",
    failedBreak: "F",
  }

// The event as an order flow event, undefined for a book event.
export const asOrderFlowEvent = (event: MarketEvent) =>
  Effect.succeed(
    Object.hasOwn(ORDER_FLOW_LETTERS, event.kind)
      ? (event as OrderFlowEvent)
      : undefined
  )

const extremeName = (event: OrderFlowEvent) =>
  Effect.succeed(event.side === "buy" ? "high" : "low")

export const orderFlowEventTitle = Effect.fnUntraced(function* (
  event: OrderFlowEvent
) {
  const extreme = yield* extremeName(event)
  switch (event.kind) {
    case "exhaustion":
      return `${event.side === "buy" ? "Buying" : "Selling"} exhaustion at the day's ${extreme}`
    case "divergence":
      return `Delta divergence at the day's ${extreme}`
    case "failedBreak":
      return `Failed break of the day's ${extreme}`
  }
})

// The figures behind the event, as its row's second line says them.
export const orderFlowEventFigures = Effect.fnUntraced(function* (
  event: OrderFlowEvent
) {
  const extreme = yield* extremeName(event)
  const aggressor = `${event.side}-aggressor`
  switch (event.kind) {
    case "exhaustion":
      return `${aggressor} lots ${yield* plain(event.peakLots)} → ${yield* plain(event.lots)} a minute · range ${event.widestTicks} → ${event.ticks} ticks`
    case "divergence":
      return `new ${extreme} ${yield* plain(event.price)} · cumulative delta ${yield* signed(event.delta)} lots vs ${yield* signed(event.earlierDelta)} at ${yield* wibClock(DateTime.toEpochMillis(event.earlierAt))}'s ${extreme} ${yield* plain(event.earlierPrice)}`
    case "failedBreak":
      return `traded to ${yield* plain(event.to)} past ${yield* plain(event.price)} on Rp${yield* plain(event.value / 1e6)} M ${aggressor} · closed back at ${yield* plain(event.close)} ${event.minutes === 0 ? "the same minute" : `${event.minutes} min later`}`
  }
})

// Either kind of event's key for the day, as a book event's: book and order
// flow kinds never share a name.
export const marketEventKey = (event: MarketEvent) => bookEventKey(event)

// Either kind's name, as a row or a tooltip says it: a book event's kind, an
// order flow event's title.
export const marketEventName = Effect.fnUntraced(function* (
  event: MarketEvent
) {
  const flow = yield* asOrderFlowEvent(event)
  return flow === undefined
    ? BOOK_EVENT_NAMES[(event as BookEvent).kind]
    : yield* orderFlowEventTitle(flow)
})

// When an event was known: a book event at its instant, an order flow event
// at its minute's close, when the rules judged it.
// Decision: a recorded day's cursor shows an order flow event from its
// minute's close on, not its start: before then the minute that makes it
// hadn't traded. See apinrdw/kumora#612.
export const marketEventKnownAt = Effect.fnUntraced(function* (
  event: MarketEvent
) {
  const at = DateTime.toEpochMillis(event.at)
  return (yield* asOrderFlowEvent(event)) === undefined ? at : at + MINUTE_MS
})

// Either kind's detail line.
export const marketEventDetail = Effect.fnUntraced(function* (
  event: MarketEvent
) {
  const flow = yield* asOrderFlowEvent(event)
  return flow === undefined
    ? yield* bookEventDetail(event as BookEvent)
    : yield* orderFlowEventFigures(flow)
})
