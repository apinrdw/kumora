// Book readings (spec apinrdw/kumora#517, "Book readings"): what the order
// book radar measures from one stock code's order book. The trading-day
// Durable Object reads every changed book on each delta tick in Sessions 1
// and 2; the Market Live page reads a recorded day's stored frame at the
// cursor with the same functions.
import { Effect, Schema, SchemaGetter } from "effect"

import { StockCode } from "./codes.ts"
import {
  SHARES_PER_LOT,
  levelValue,
  type BookLevel,
  type OrderBook,
} from "./order-book.ts"
import type { MarketPhase, WibDate } from "./schedule.ts"
import { priceLimitsOf, ticksBetween } from "./ticks.ts"

// Decision: every reading covers the best 5 levels a side, fixed: the user
// can't change it. See spec apinrdw/kumora#517, "Book readings".
const NEAR_LEVELS = 5

// The market phases book readings are read and book events found in: Sessions
// 1 and 2. In any other, readings keep their last values, marked as paused.
export const READING_PHASES: ReadonlySet<MarketPhase> = new Set([
  "session-1",
  "session-2",
])

// One side's readings over its best five levels: near depth in rupiah
// (`nearDepth`) and lots, the empty ticks between its best level and its fifth with the widest
// single gap, and its lots per order (none without an order).
const SideReadings = Schema.Struct({
  nearDepth: Schema.Finite,
  lots: Schema.Finite,
  emptyTicks: Schema.Int,
  widestGap: Schema.Int,
  lotsPerOrder: Schema.UndefinedOr(Schema.Finite),
})
type SideReadings = typeof SideReadings.Type

// The auto-reject limit a code sits at.
const Limit = Schema.Literals(["upper", "lower"])
export type Limit = typeof Limit.Type

// One code's readings. Imbalance runs from -1 (offers only) to 1 (bids only),
// none when both sides are empty; the spread is none when either is. `limit`
// marks a code at its upper or lower auto-reject limit. `at` is the book's
// as-of.
const BookReadingsFields = Schema.Struct({
  code: StockCode,
  at: Schema.DateTimeUtc,
  imbalance: Schema.UndefinedOr(Schema.Finite),
  spread: Schema.UndefinedOr(
    Schema.Struct({ ticks: Schema.Int, percent: Schema.Finite })
  ),
  limit: Schema.UndefinedOr(Limit),
  bid: SideReadings,
  offer: SideReadings,
})

const LIMIT_CODES = { upper: 1, lower: -1 } as const

// A reading's tuple: [code, as-of, imbalance, spread ticks, spread %,
// limit (1 upper, -1 lower, 0 none), then the bid's and the offer's near depth,
// lots, empty ticks, widest gap and lots per order], none as null. Encoding
// rounds imbalance and the spread to 4 places, lots per order to 2 and near depth
// to the rupiah: finer digits are noise on the page.
// Decision: readings travel as a tuple: every changed code's go out in each
// delta, and keys would double the ~100 bytes the spec budgets for one. See
// spec apinrdw/kumora#517, "Data".
const WireSide = [
  Schema.Finite,
  Schema.Finite,
  Schema.Int,
  Schema.Int,
  Schema.NullOr(Schema.Finite),
] as const

export const BookReadings = Schema.Tuple([
  StockCode,
  Schema.DateTimeUtcFromMillis,
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Int),
  Schema.NullOr(Schema.Finite),
  Schema.Literals([1, -1, 0]),
  ...WireSide,
  ...WireSide,
]).pipe(
  Schema.decodeTo(Schema.toType(BookReadingsFields), {
    decode: SchemaGetter.transform(
      ([
        code,
        at,
        imbalance,
        spreadTicks,
        spreadPercent,
        limit,
        bidNearDepth,
        bidLots,
        bidEmpty,
        bidWidest,
        bidPerOrder,
        offerNearDepth,
        offerLots,
        offerEmpty,
        offerWidest,
        offerPerOrder,
      ]) => {
        const side = (
          nearDepth: number,
          lots: number,
          emptyTicks: number,
          widestGap: number,
          lotsPerOrder: number | null
        ): SideReadings => ({
          nearDepth,
          lots,
          emptyTicks,
          widestGap,
          lotsPerOrder: lotsPerOrder ?? undefined,
        })
        return {
          code,
          at,
          imbalance: imbalance ?? undefined,
          spread:
            spreadTicks === null || spreadPercent === null
              ? undefined
              : { ticks: spreadTicks, percent: spreadPercent },
          limit: limit === 1 ? "upper" : limit === -1 ? "lower" : undefined,
          bid: side(bidNearDepth, bidLots, bidEmpty, bidWidest, bidPerOrder),
          offer: side(
            offerNearDepth,
            offerLots,
            offerEmpty,
            offerWidest,
            offerPerOrder
          ),
        } as const
      }
    ),
    encode: SchemaGetter.transform((readings) => {
      const rounded = (value: number | undefined, places: number) => {
        if (value === undefined) return null
        const scale = 10 ** places
        return Math.round(value * scale) / scale
      }
      const side = (each: SideReadings) =>
        [
          Math.round(each.nearDepth),
          each.lots,
          each.emptyTicks,
          each.widestGap,
          rounded(each.lotsPerOrder, 2),
        ] as const
      return [
        readings.code,
        readings.at,
        rounded(readings.imbalance, 4),
        readings.spread?.ticks ?? null,
        rounded(readings.spread?.percent, 4),
        readings.limit === undefined ? 0 : LIMIT_CODES[readings.limit],
        ...side(readings.bid),
        ...side(readings.offer),
      ] as const
    }),
  })
)
export type BookReadings = typeof BookReadings.Type

// One side's best five levels, best first.
const readSide = Effect.fnUntraced(function* (
  levels: ReadonlyArray<BookLevel>
) {
  const near = levels.slice(0, NEAR_LEVELS)
  let nearDepth = 0
  let lots = 0
  let orders = 0
  let emptyTicks = 0
  let widestGap = 0
  for (const [index, level] of near.entries()) {
    nearDepth += levelValue(level.price, level.lots)
    lots += level.lots
    orders += level.orders
    const before = near[index - 1]
    if (before === undefined) continue
    const gap =
      (yield* ticksBetween(
        Math.min(before.price, level.price),
        Math.max(before.price, level.price)
      )) - 1
    if (gap <= 0) continue
    emptyTicks += gap
    widestGap = Math.max(widestGap, gap)
  }
  const side: SideReadings = {
    nearDepth,
    lots,
    emptyTicks,
    widestGap,
    lotsPerOrder: orders > 0 ? lots / orders : undefined,
  }
  return side
})

// Whether the book sits at an auto-reject limit: one side empty and the last
// price at the limit its previous close sets. Special Monitoring Board codes
// show no readings, so the regular boards' rule applies.
const limitOf = Effect.fnUntraced(function* (
  book: OrderBook,
  last: number | undefined,
  date: WibDate
) {
  if (book.previousClose === undefined || last === undefined) return undefined
  const limits = yield* priceLimitsOf(book.previousClose, date, "regular")
  if (book.offers.length === 0 && last >= limits.upper) return "upper" as const
  if (book.bids.length === 0 && last <= limits.lower) return "lower" as const
  return undefined
})

// `book`'s readings on `date`, with the code's last price (for the limit
// mark).
export const bookReadingsOf = Effect.fnUntraced(function* (
  book: OrderBook,
  context: {
    readonly date: WibDate
    readonly last: number | undefined
  }
) {
  const bid = yield* readSide(book.bids)
  const offer = yield* readSide(book.offers)
  const total = bid.lots + offer.lots
  const bestBid = book.bids[0]?.price
  const bestOffer = book.offers[0]?.price
  const readings: BookReadings = {
    code: book.code,
    at: book.at,
    imbalance: total > 0 ? (bid.lots - offer.lots) / total : undefined,
    spread:
      bestBid === undefined || bestOffer === undefined
        ? undefined
        : {
            ticks: yield* ticksBetween(bestBid, bestOffer),
            percent:
              ((bestOffer - bestBid) / ((bestOffer + bestBid) / 2)) * 100,
          },
    limit: yield* limitOf(book, context.last, context.date),
    bid,
    offer,
  }
  return readings
})

// An order size for the fill estimate: a rupiah amount or a count of lots.
export interface OrderSize {
  readonly unit: "rupiah" | "lots"
  readonly amount: number
}

// What filling an order against one side would take: the levels used, the
// last price reached, the average fill price and its slippage from the best
// price, and the lots and rupiah filled. `short` marks a size the levels the
// book carries can't fill; the lots and rupiah are then what they cover.
export interface FillEstimate {
  readonly levels: number
  readonly last: number
  readonly average: number
  readonly slippage: { readonly ticks: number; readonly percent: number }
  readonly lots: number
  readonly rupiah: number
  readonly short: boolean
}

// Filling `size` at market against `book`: a buy walks the offers and a sell
// the bids, best first, in whole lots. None when nothing fills: the side is
// empty, or the size is short of one lot at the best price.
export const fillEstimateOf = Effect.fnUntraced(function* (
  book: OrderBook,
  side: "buy" | "sell",
  size: OrderSize
) {
  const levels = side === "buy" ? book.offers : book.bids
  let left = size.amount
  let lots = 0
  let rupiah = 0
  let used = 0
  for (const level of levels) {
    const lot = level.price * SHARES_PER_LOT
    const take = Math.min(
      level.lots,
      size.unit === "lots" ? left : Math.floor(left / lot)
    )
    if (take <= 0) break
    lots += take
    rupiah += take * lot
    used += 1
    left -= size.unit === "lots" ? take : take * lot
  }
  const best = levels[0]
  const last = levels[used - 1]
  if (best === undefined || last === undefined) return undefined
  const average = rupiah / lots / SHARES_PER_LOT
  const fill: FillEstimate = {
    levels: used,
    last: last.price,
    average,
    slippage: {
      ticks: yield* ticksBetween(
        Math.min(best.price, last.price),
        Math.max(best.price, last.price)
      ),
      percent: (Math.abs(average - best.price) / best.price) * 100,
    },
    lots,
    rupiah,
    // Every level used and still a lot or more to fill.
    short:
      used === levels.length &&
      left >= (size.unit === "lots" ? 1 : last.price * SHARES_PER_LOT),
  }
  return fill
})
