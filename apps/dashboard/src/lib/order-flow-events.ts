// How the page names order flow events (spec apinrdw/kumora#605, "Order flow
// events: the rules" and "on the page"): each kind's letter, title and
// figures line. The scanner's feed and chips and the Book readout list show
// them with book events, as one kind of row.
import {
  WibDate,
  type BookEvent,
  type OrderFlowEvent,
  type OrderFlowEventKind,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { BOOK_EVENT_NAMES, bookEventDetail } from "./book-events"
import { plain, signed, wibClock } from "./format"
import { minuteEnd } from "./replay"

// The events the radar and the readout list: a book event or an order flow
// event, told apart by `kind`.
export type MarketEvent = BookEvent | OrderFlowEvent

// The first day the trading-day object records order flow events,
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

// Each kind's glossary name, as the alert rule editor lists it and the
// titles say it.
export const ORDER_FLOW_KIND_NAMES: Readonly<
  Record<OrderFlowEventKind, string>
> = {
  exhaustion: "Exhaustion",
  divergence: "Delta divergence",
  failedBreak: "Failed break",
}

// Which of the two the event is, told apart by its kind.
export const splitEvent = (event: MarketEvent) =>
  Effect.succeed(
    event.kind === "exhaustion" ||
      event.kind === "divergence" ||
      event.kind === "failedBreak"
      ? ({ _tag: "orderFlow", event } as const)
      : ({ _tag: "book", event } as const)
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
      return `${ORDER_FLOW_KIND_NAMES.divergence} at the day's ${extreme}`
    case "failedBreak":
      return `${ORDER_FLOW_KIND_NAMES.failedBreak} of the day's ${extreme}`
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

// Either kind's name, as a row or a tooltip says it: a book event's kind, an
// order flow event's title.
export const marketEventName = Effect.fnUntraced(function* (
  event: MarketEvent
) {
  const split = yield* splitEvent(event)
  return split._tag === "book"
    ? BOOK_EVENT_NAMES[split.event.kind]
    : yield* orderFlowEventTitle(split.event)
})

// When an event was known: a book event at its instant, an order flow event
// at its minute's end, where picking its candle puts the cursor.
// A recorded day's cursor shows an order flow event from its
// minute's end on (lib/replay.ts minuteEnd), not its start: before then the
// minute that makes it hadn't traded. See apinrdw/kumora#612.
export const marketEventKnownAt = Effect.fnUntraced(function* (
  event: MarketEvent
) {
  const at = DateTime.toEpochMillis(event.at)
  return (yield* splitEvent(event))._tag === "book" ? at : yield* minuteEnd(at)
})

// Either kind's detail line.
export const marketEventDetail = Effect.fnUntraced(function* (
  event: MarketEvent
) {
  const split = yield* splitEvent(event)
  return split._tag === "book"
    ? yield* bookEventDetail(split.event)
    : yield* orderFlowEventFigures(split.event)
})
