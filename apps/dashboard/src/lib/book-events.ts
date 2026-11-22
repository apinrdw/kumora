// How the page names book events (spec apinrdw/kumora#517, "Book events"):
// each kind's name, its ladder mark and its detail line. The Book readout,
// the ladder and the heatmap use them; so do the scanner's feed and alerts.
import {
  WibDate,
  type BookEvent,
  type BookEventKind,
  type OrderFlowEvent,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { compact, plain } from "./format"

// Decision: the first day the trading-day object records book events, named
// on an earlier day's readout. Its GET says whether a day kept them; this
// date is only the copy, set to the day book events ship. See spec
// apinrdw/kumora#517, "Book events".
export const BOOK_EVENTS_FROM = WibDate.make("2026-11-19")

export const BOOK_EVENT_NAMES: Readonly<Record<BookEventKind, string>> = {
  absorbed: "Absorbed",
  eaten: "Eaten",
  reloaded: "Reloaded",
  appeared: "Wall appeared",
  pulled: "Pulled",
  moved: "Wall moved",
}

// The ladder's two-character mark of each kind.
export const BOOK_EVENT_MARKS: Readonly<Record<BookEventKind, string>> = {
  absorbed: "AB",
  eaten: "EA",
  reloaded: "RL",
  appeared: "W+",
  pulled: "W−",
  moved: "W→",
}

// The wall events: the heatmap draws them as a square, the rest as a
// diamond.
export const WALL_KINDS: ReadonlySet<BookEventKind> = new Set([
  "appeared",
  "pulled",
  "moved",
])

// The event's detail line, as the readout lists it.
export const bookEventDetail = Effect.fnUntraced(function* (event: BookEvent) {
  const price = yield* plain(event.price)
  const lots = yield* compact(event.lots)
  const orders = `${event.orders} ${event.orders === 1 ? "order" : "orders"}`
  switch (event.kind) {
    case "absorbed":
      return `${lots} lots traded into ${price}, ${yield* compact(event.shown)} still shown`
    case "eaten":
      return `${price} gone, trades explain ${Math.round(event.share * 100)}%`
    case "reloaded":
      return `${price} refilled ${event.refills}× · ${event.crowd ? "crowd" : "single"}`
    case "appeared":
      return `${lots} lots at ${price} · ${orders} · ${event.ticks} ticks away`
    case "pulled":
      return `${lots} lots at ${price} · ${orders} · ${event.ticks} ticks${event.approached ? ", as price approached" : ""}`
    case "moved":
      return `${lots} lots ${price} → ${yield* plain(event.to)}`
  }
})

// A book or order flow event's key for the day: its code, kind, side,
// price and time. The two never share a kind's name.
export const eventKey = (
  event: Pick<
    BookEvent | OrderFlowEvent,
    "code" | "kind" | "side" | "price" | "at"
  >
) =>
  Effect.sync(
    () =>
      `${event.code}|${event.kind}|${event.side}|${event.price}|${DateTime.toEpochMillis(event.at)}`
  )
