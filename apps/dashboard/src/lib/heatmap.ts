// The book heatmap's slice weighting (spec apinrdw/kumora#263, "The
// trading-day Durable Object"): the trading-day Durable Object works each
// closed book chunk into its six stored slices with it (book-chunks.ts), and
// a live page the slices after the heatmap GET from the books its deltas
// carry (heatmap-store.ts).
import {
  HEAT_SLICE_MS,
  type BookLevel,
  type HeatLevel,
  type HeatSlice,
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

// The slices from `from` up to `to`, both on slice starts: each price's
// resting lots, bid and offer apart, averaged over the slice by how long each
// book held them, in whole lots. `changes` ascend by time; the latest at or
// before `from` is the book in force then, and before the first there is
// none, which rests nothing. A slice with no lots is left out.
// Decision: the weighting loop and its helpers (`add`, `levelsOf`) are
// plain, with one Effect around it: a busy code's day runs it over ~33 K
// served frames of up to 20 levels a side. Over such a day (33,000 frames,
// 20 levels a side, 2,622 slices; Node 26, 2 cores, median of 15) it took
// 33.5 ms plain and 45–48 ms with each helper an Effect.sync yielded per
// call, about 35% slower. Measured 2026-11-14.
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
