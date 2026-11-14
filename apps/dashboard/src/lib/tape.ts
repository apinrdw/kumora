// The whole-market tape the Market Live page keeps (spec apinrdw/kumora#138,
// "The page", "Tape"): continuous trading capped at the newest 10,000 trades,
// and each auction match folded into one row kept outside that cap. Deltas
// mutate it in place, so a 1,278-trade delta costs a few milliseconds; the
// view copies it with `freezeTape` when it must hold still.
// Decision: the per-trade helpers return Effects like every other function
// here. That costs about 1 µs a trade on node (50k trades: 161 ms against
// 101 ms as plain functions); a 1,278-trade delta still takes about 3.6 ms.
import {
  SHARES_PER_LOT,
  TradeNumberOrder,
  type RunningTrade,
  type StockCode,
  type TradeNumber,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { tradePosition } from "./trade-position"

// The two auction matches whose prints fold.
export type AuctionMatch = "opening" | "closing"

// Decision: an auction match is a regular-board print in the 08:58:00 or
// 16:00:00 WIB second, the IDX matching instants. Ajaib stamps them on the
// whole second and Stockbit a few milliseconds in. A negotiated or cash print
// in that second is continuous trading and does not fold.
const MATCH_SECONDS: ReadonlyMap<number, AuctionMatch> = new Map([
  [8 * 3_600 + 58 * 60, "opening"],
  [16 * 3_600, "closing"],
])

const WIB_OFFSET_SECONDS = 7 * 3_600
const DAY_SECONDS = 86_400

const auctionMatchOf = (trade: RunningTrade) =>
  Effect.sync((): AuctionMatch | undefined => {
    if (trade.board !== "RG") return undefined
    const epochSeconds = Math.floor(DateTime.toEpochMillis(trade.time) / 1_000)
    return MATCH_SECONDS.get((epochSeconds + WIB_OFFSET_SECONDS) % DAY_SECONDS)
  })

// Decision: a big trade is worth Rp1 B or more on the regular board (spec
// apinrdw/kumora#138, "Tape"), a fixed line for now.
export const BIG_TRADE_IDR = 1_000_000_000

export const tradeValue = (trade: RunningTrade) =>
  Effect.sync(() => trade.price * trade.lots * SHARES_PER_LOT)

export const isBigTrade = (trade: RunningTrade) =>
  Effect.map(
    tradeValue(trade),
    (value) => trade.board === "RG" && value >= BIG_TRADE_IDR
  )

// Decision: the page keeps the 10,000 newest continuous-trading trades, the
// count apinrdw/kumora#136 measured smooth at the opening match's peak.
const KEPT_TRADES = 10_000

type Fold = {
  readonly match: AuctionMatch
  // Ascending by trade number.
  readonly trades: Array<RunningTrade>
  value: number
  readonly codes: Map<StockCode, number>
}

export type Tape = {
  // Continuous trading, ascending by trade number.
  readonly continuous: Array<RunningTrade>
  // Ascending by their newest trade number.
  readonly folds: Array<Fold>
  // The newest trade number the cap dropped: an older arrival is dropped too.
  evictedThrough: TradeNumber | undefined
  // Every trade number the tape took in, for the "N new trades" count.
  received: number
}

export const emptyTape = () =>
  Effect.sync((): Tape => ({
    continuous: [],
    folds: [],
    evictedThrough: undefined,
    received: 0,
  }))

// A copy later deltas leave alone.
export const freezeTape = (tape: Tape) =>
  Effect.sync((): Tape => ({
    continuous: [...tape.continuous],
    folds: tape.folds.map((fold) => ({
      ...fold,
      trades: [...fold.trades],
      codes: new Map(fold.codes),
    })),
    evictedThrough: tape.evictedThrough,
    received: tape.received,
  }))

// Inserts `trade` in an ascending list, or replaces the trade it numbers,
// appending without a search when it is the newest.
const place = (trades: Array<RunningTrade>, trade: RunningTrade) =>
  Effect.suspend(() => {
    const last = trades.at(-1)
    if (
      last === undefined ||
      TradeNumberOrder(last.tradeNumber, trade.tradeNumber) < 0
    )
      return Effect.sync(() => void trades.push(trade))
    return Effect.map(tradePosition(trades, trade.tradeNumber), (at) => {
      if (trades[at]?.tradeNumber === trade.tradeNumber) trades[at] = trade
      else trades.splice(at, 0, trade)
    })
  })

const removeFrom = (trades: Array<RunningTrade>, number: TradeNumber) =>
  Effect.map(tradePosition(trades, number), (at) =>
    trades[at]?.tradeNumber === number ? trades.splice(at, 1)[0] : undefined
  )

const countCode = (fold: Fold, code: StockCode, by: 1 | -1) =>
  Effect.sync(() => {
    const count = (fold.codes.get(code) ?? 0) + by
    if (count === 0) fold.codes.delete(code)
    else fold.codes.set(code, count)
  })

const addToFold = Effect.fnUntraced(function* (
  fold: Fold,
  trade: RunningTrade
) {
  fold.value += yield* tradeValue(trade)
  yield* countCode(fold, trade.code, 1)
})

const takeFromFold = Effect.fnUntraced(function* (
  fold: Fold,
  trade: RunningTrade
) {
  fold.value -= yield* tradeValue(trade)
  yield* countCode(fold, trade.code, -1)
})

const newestOf = (fold: Fold) =>
  Effect.sync((): TradeNumber => fold.trades.at(-1)!.tradeNumber)

const foldFor = (tape: Tape, match: AuctionMatch) =>
  Effect.sync((): Fold => {
    const held = tape.folds.find((fold) => fold.match === match)
    if (held !== undefined) return held
    const fold: Fold = { match, trades: [], value: 0, codes: new Map() }
    tape.folds.push(fold)
    return fold
  })

// Takes a trade number already held out of wherever it sits: a later feed
// can change its board or time, and with them whether it folds.
const takeOut = Effect.fnUntraced(function* (tape: Tape, number: TradeNumber) {
  if ((yield* removeFrom(tape.continuous, number)) !== undefined) return true
  for (const fold of tape.folds) {
    const held = yield* removeFrom(fold.trades, number)
    if (held === undefined) continue
    yield* takeFromFold(fold, held)
    return true
  }
  return false
})

// Whether the tape holds `number`, or dropped it past the cap.
const seenBy = Effect.fnUntraced(function* (tape: Tape, number: TradeNumber) {
  if (
    tape.evictedThrough !== undefined &&
    TradeNumberOrder(number, tape.evictedThrough) <= 0
  )
    return true
  for (const trades of [tape.continuous, ...tape.folds.map((f) => f.trades)])
    if (trades[yield* tradePosition(trades, number)]?.tradeNumber === number)
      return true
  return false
})

// `seen`: the trade was held before a snapshot started the tape over, so it
// isn't received again.
const insert = Effect.fnUntraced(function* (
  tape: Tape,
  trade: RunningTrade,
  seen = false
) {
  const match = yield* auctionMatchOf(trade)
  const known = yield* takeOut(tape, trade.tradeNumber)
  const tooOld =
    tape.evictedThrough !== undefined &&
    TradeNumberOrder(trade.tradeNumber, tape.evictedThrough) <= 0
  if (match === undefined) {
    if (tooOld && !known) return
    yield* place(tape.continuous, trade)
  } else {
    const held = tape.folds.find((fold) => fold.match === match)
    if (tooOld && held === undefined) return
    const fold = held ?? (yield* foldFor(tape, match))
    yield* place(fold.trades, trade)
    yield* addToFold(fold, trade)
  }
  if (!known && !seen) tape.received += 1
})

// Drops the oldest continuous trades past the cap, then each fold the drop
// passed: a fold leaves once the trades on both sides of it have.
const evict = Effect.fnUntraced(function* (tape: Tape) {
  const excess = tape.continuous.length - KEPT_TRADES
  if (excess > 0) {
    const dropped = tape.continuous.splice(0, excess)
    tape.evictedThrough = dropped.at(-1)!.tradeNumber
  }
  const through = tape.evictedThrough
  for (let index = tape.folds.length - 1; index >= 0; index--) {
    const fold = tape.folds[index]!
    const gone =
      fold.trades.length === 0 ||
      (through !== undefined &&
        TradeNumberOrder(yield* newestOf(fold), through) < 0)
    if (gone) tape.folds.splice(index, 1)
  }
  // Array.sort calls the comparator back, so it reads each newest trade
  // number itself.
  tape.folds.sort((a, b) =>
    TradeNumberOrder(a.trades.at(-1)!.tradeNumber, b.trades.at(-1)!.tradeNumber)
  )
})

// The tape after one viewer message. A snapshot starts it over, its received
// count carried on and counting only the trades the tape didn't hold, so a
// frozen tape's "N new trades" survives a reconnect; a delta's trades go in by
// trade number, a known one replacing what the tape held.
export const applyViewerMessage = Effect.fnUntraced(function* (
  tape: Tape,
  message: ViewerDown
): Effect.fn.Return<Tape> {
  if (message._tag !== "Snapshot") {
    for (const trade of message.tape) yield* insert(tape, trade)
    yield* evict(tape)
    return tape
  }
  const next = yield* emptyTape()
  next.received = tape.received
  for (const trade of message.tape)
    yield* insert(next, trade, yield* seenBy(tape, trade.tradeNumber))
  yield* evict(next)
  return next
})

export type TapeRow =
  | {
      readonly kind: "trade"
      readonly trade: RunningTrade
      // The auction match whose expanded fold the trade sits in.
      readonly inFold: AuctionMatch | undefined
    }
  | {
      readonly kind: "fold"
      readonly match: AuctionMatch
      readonly trades: number
      readonly value: number
      readonly codes: number
      // Still taking prints: no continuous trade after it has arrived yet.
      readonly live: boolean
    }

// The list as the view lays it out, newest first: runs of continuous trades,
// with each fold's summary row (and, when open, its trades) at its place.
type Segment =
  | {
      readonly kind: "continuous"
      readonly from: number
      readonly length: number
    }
  | { readonly kind: "fold"; readonly fold: Fold; readonly open: boolean }

const segmentsOf = Effect.fnUntraced(function* (
  tape: Tape,
  open: ReadonlySet<AuctionMatch>
): Effect.fn.Return<Array<Segment>> {
  const segments: Array<Segment> = []
  // `from` counts back from the newest continuous trade.
  let taken = 0
  for (let index = tape.folds.length - 1; index >= 0; index--) {
    const fold = tape.folds[index]!
    const newer =
      tape.continuous.length -
      (yield* tradePosition(tape.continuous, yield* newestOf(fold)))
    if (newer > taken)
      segments.push({ kind: "continuous", from: taken, length: newer - taken })
    taken = Math.max(taken, newer)
    segments.push({ kind: "fold", fold, open: open.has(fold.match) })
  }
  if (tape.continuous.length > taken)
    segments.push({
      kind: "continuous",
      from: taken,
      length: tape.continuous.length - taken,
    })
  return segments
})

const segmentLength = (segment: Segment) =>
  Effect.sync(() =>
    segment.kind === "continuous"
      ? segment.length
      : 1 + (segment.open ? segment.fold.trades.length : 0)
  )

export const tapeLength = Effect.fnUntraced(function* (
  tape: Tape,
  open: ReadonlySet<AuctionMatch>
) {
  let length = 0
  for (const segment of yield* segmentsOf(tape, open))
    length += yield* segmentLength(segment)
  return length
})

// Rows `from` (inclusive) to `to` (exclusive) of the list, newest first.
export const tapeRows = Effect.fnUntraced(function* (
  tape: Tape,
  open: ReadonlySet<AuctionMatch>,
  from: number,
  to: number
): Effect.fn.Return<Array<TapeRow>> {
  const rows: Array<TapeRow> = []
  let start = 0
  for (const segment of yield* segmentsOf(tape, open)) {
    const length = yield* segmentLength(segment)
    const first = Math.max(from, start)
    const last = Math.min(to, start + length)
    for (let index = first; index < last; index++) {
      const offset = index - start
      if (segment.kind === "continuous") {
        const at = tape.continuous.length - 1 - segment.from - offset
        rows.push({
          kind: "trade",
          trade: tape.continuous[at]!,
          inFold: undefined,
        })
      } else if (offset === 0) {
        const { fold } = segment
        const newestContinuous = tape.continuous.at(-1)
        rows.push({
          kind: "fold",
          match: fold.match,
          trades: fold.trades.length,
          value: fold.value,
          codes: fold.codes.size,
          live:
            newestContinuous === undefined ||
            TradeNumberOrder(
              newestContinuous.tradeNumber,
              yield* newestOf(fold)
            ) < 0,
        })
      } else {
        const { trades, match } = segment.fold
        rows.push({
          kind: "trade",
          trade: trades[trades.length - offset]!,
          inFold: match,
        })
      }
    }
    start += length
    if (start >= to) break
  }
  return rows
})
