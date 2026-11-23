// The book heatmap's slice weighting (spec apinrdw/kumora#263, "The
// trading-day Durable Object"): the trading-day Durable Object works each
// closed book chunk into its six stored slices with it (book-chunks.ts), and
// a live page the slices after the heatmap GET from the books its deltas
// carry (heatmap-store.ts). Both carry a book over the minutes with no frame
// with it, the object when it answers the GET (heat-rows.ts).
import {
  HEAT_SLICE_MS,
  streamingEndOf,
  type BookLevel,
  type HeatLevel,
  type HeatSlice,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

// The resting levels of one book, each side best first.
export interface RestingBook {
  readonly bids: ReadonlyArray<BookLevel>
  readonly offers: ReadonlyArray<BookLevel>
}

// A book and when it came into force.
export interface BookChange {
  readonly at: number
  readonly book: RestingBook
}

// Lot-milliseconds at one price, each side.
interface Weight {
  bid: number
  offer: number
}

const add = (
  weights: Map<number, Weight>,
  book: RestingBook,
  duration: number
) => {
  for (const level of book.bids) {
    const weight = weights.get(level.price) ?? { bid: 0, offer: 0 }
    weight.bid += level.lots * duration
    weights.set(level.price, weight)
  }
  for (const level of book.offers) {
    const weight = weights.get(level.price) ?? { bid: 0, offer: 0 }
    weight.offer += level.lots * duration
    weights.set(level.price, weight)
  }
}

// A slice's levels from its weights: each side's lots averaged over the
// slice, rounded to whole lots, ascending by price, none left at 0.
const levelsOf = (weights: ReadonlyMap<number, Weight>) => {
  const levels: Array<HeatLevel> = []
  for (const [price, weight] of [...weights].sort(([a], [b]) => a - b)) {
    const bid = Math.round(weight.bid / HEAT_SLICE_MS)
    const offer = Math.round(weight.offer / HEAT_SLICE_MS)
    if (bid > 0 || offer > 0) levels.push([price, bid, offer])
  }
  return levels
}

// Decision: a book holds until the next frame, the last to streaming end
// (apps/dashboard/docs/adr/0030-a-book-stays-in-force-until-the-next-frame.md)
export const heatEndOf = (date: WibDate) =>
  Effect.map(
    streamingEndOf(date),
    (end) =>
      (Math.floor(DateTime.toEpochMillis(end) / HEAT_SLICE_MS) + 1) *
      HEAT_SLICE_MS
  )

// The slices from `from` up to `to`, both on slice starts: each price's
// resting lots, bid and offer apart, averaged over the slice by how long each
// book held them, in whole lots. `changes` ascend by time; the latest at or
// before `from` is the book in force then, and before the first there is
// none, which rests nothing. A slice with no lots is left out.
// The weighting loop and its helpers stay plain, one Effect around
// them: a busy code's day (~33 K frames of 20 levels a side, 2,622 slices)
// took 33.5 ms plain and 45–48 ms with `add` and `levelsOf` as Effect.sync
// yielded per call, about 35% slower (Node 26, 2 cores, median of 15, measured
// 2026-11-14).
export const heatSlices = (
  changes: ReadonlyArray<BookChange>,
  from: number,
  to: number
) =>
  Effect.sync(() => {
    const slices: Array<HeatSlice> = []
    let next = 0
    let held: RestingBook | undefined
    // Adds the book held from `since` to `until`.
    const hold = (
      weights: Map<number, Weight>,
      since: number,
      until: number
    ) => {
      if (held !== undefined) add(weights, held, until - since)
    }
    while (next < changes.length && changes[next]!.at <= from)
      held = changes[next++]!.book
    for (let start = from; start < to; start += HEAT_SLICE_MS) {
      const end = start + HEAT_SLICE_MS
      const weights = new Map<number, Weight>()
      let since = start
      for (; next < changes.length && changes[next]!.at < end; next++) {
        hold(weights, since, changes[next]!.at)
        held = changes[next]!.book
        since = changes[next]!.at
      }
      hold(weights, since, end)
      const levels = levelsOf(weights)
      if (levels.length > 0)
        slices.push({ at: DateTime.makeUnsafe(start), levels })
    }
    return slices
  })
