// Book events (spec apinrdw/kumora#517, "Book events"): what the level
// ledger (dashboard level-ledger.ts) shows a price level doing. The
// trading-day Durable Object finds them, stores them per day and sends them
// to viewers; the page names them with the detail lines in its
// lib/book-events.ts.
import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// Decision: one rolling 30 s window for every book event, and a side with
// fewer than 2 frames in it is too quiet to read. See apinrdw/kumora#508.
export const BOOK_EVENT_WINDOW_MS = 30_000
export const MIN_SIDE_FRAMES = 2

// The book side an event happened on.
const BookEventSide = Schema.Literals(["bid", "offer"])

// What every event carries: its code, the side frame's time it was read on,
// its side and price, and the lots and orders its detail line names.
const common = {
  code: StockCode,
  at: Schema.DateTimeUtcFromMillis,
  side: BookEventSide,
  price: Schema.Finite,
  lots: Schema.Finite,
  orders: Schema.Int,
}

// The level took `lots` in trades within the window, at least the lots it
// showed at the window's start, and still shows `shown` lots in `orders`.
const Absorbed = Schema.Struct({
  kind: Schema.Literal("absorbed"),
  ...common,
  shown: Schema.Finite,
})

// The level, `lots` at its peak in `orders` orders, left the book; trades
// explain `share` (0 to 1) of its peak.
const Eaten = Schema.Struct({
  kind: Schema.Literal("eaten"),
  ...common,
  share: Schema.Finite,
})

// The best level traded `lots` beyond what it showed, or was hit down and
// refilled: the `refills`th time at this price since the ledger last reset.
// `crowd` when several new orders refilled it, single otherwise.
const Reloaded = Schema.Struct({
  kind: Schema.Literal("reloaded"),
  ...common,
  refills: Schema.Int,
  crowd: Schema.Boolean,
})

// A level became a wall of `lots` in `orders`, `ticks` from its side's best.
const WallAppeared = Schema.Struct({
  kind: Schema.Literal("appeared"),
  ...common,
  ticks: Schema.Int,
})

// A wall of `lots` in `orders` lost at least half of them, `ticks` from its
// side's best, `approached` when price had been moving toward it.
const WallPulled = Schema.Struct({
  kind: Schema.Literal("pulled"),
  ...common,
  ticks: Schema.Int,
  approached: Schema.Boolean,
})

// `lots` in `orders` left `price` and about as many arrived at `to`.
const WallMoved = Schema.Struct({
  kind: Schema.Literal("moved"),
  ...common,
  to: Schema.Finite,
})

export const BookEvent = Schema.Union([
  Absorbed,
  Eaten,
  Reloaded,
  WallAppeared,
  WallPulled,
  WallMoved,
])
export type BookEvent = typeof BookEvent.Type
export type BookEventKind = BookEvent["kind"]

// Decision: a snapshot carries the day's newest 100 book events across every
// code, plus the selected code's whole day: the scanner's feed shows the
// newest, the readout one code's day. See spec apinrdw/kumora#517, "Book
// events".
export const SNAPSHOT_BOOK_EVENTS = 100
