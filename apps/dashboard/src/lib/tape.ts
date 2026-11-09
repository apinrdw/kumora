// The whole-market tape the Market Live page keeps (spec apinrdw/kumora#138,
// "The page", "Tape"): continuous trading capped at the newest 10,000 trades,
// and each auction match folded into one row kept outside that cap. Deltas
// mutate it in place, so a 1,278-trade delta costs a few milliseconds; the
// view copies it with `freezeTape` when it must hold still.
import {
  TradeNumberOrder,
  type RunningTrade,
  type TradeNumber,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime } from "effect"

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

function auctionMatchOf(trade: RunningTrade): AuctionMatch | undefined {
  if (trade.board !== "RG") return undefined
  const epochSeconds = Math.floor(DateTime.toEpochMillis(trade.time) / 1_000)
  return MATCH_SECONDS.get((epochSeconds + WIB_OFFSET_SECONDS) % DAY_SECONDS)
}

// Decision: a big trade is worth Rp1 B or more on the regular board (spec
// apinrdw/kumora#138, "Tape"), a fixed line for now.
const BIG_TRADE_IDR = 1_000_000_000

export const tradeValue = (trade: RunningTrade): number =>
  trade.price * trade.lots * 100

export const isBigTrade = (trade: RunningTrade): boolean =>
  trade.board === "RG" && tradeValue(trade) >= BIG_TRADE_IDR

// Decision: the page keeps the 10,000 newest continuous-trading trades, the
// count apinrdw/kumora#136 measured smooth at the opening match's peak.
const KEPT_TRADES = 10_000

type Fold = {
  readonly match: AuctionMatch
  // Ascending by trade number.
  readonly trades: Array<RunningTrade>
  value: number
  readonly codes: Map<string, number>
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

export const emptyTape = (): Tape => ({
  continuous: [],
  folds: [],
  evictedThrough: undefined,
  received: 0,
})

// A copy later deltas leave alone.
export const freezeTape = (tape: Tape): Tape => ({
  continuous: [...tape.continuous],
  folds: tape.folds.map((fold) => ({
    ...fold,
    trades: [...fold.trades],
    codes: new Map(fold.codes),
  })),
  evictedThrough: tape.evictedThrough,
  received: tape.received,
})

// Where `number` sits, or would be inserted, in a list ascending by trade
// number.
function positionOf(
  trades: ReadonlyArray<RunningTrade>,
  number: TradeNumber
): number {
  let low = 0
  let high = trades.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (TradeNumberOrder(trades[middle]!.tradeNumber, number) < 0)
      low = middle + 1
    else high = middle
  }
  return low
}

// Inserts or replaces `trade` in an ascending list, appending without a search
// when it is the newest. Answers the trade it replaced.
function place(
  trades: Array<RunningTrade>,
  trade: RunningTrade
): RunningTrade | undefined {
  const last = trades.at(-1)
  if (
    last === undefined ||
    TradeNumberOrder(last.tradeNumber, trade.tradeNumber) < 0
  ) {
    trades.push(trade)
    return undefined
  }
  const at = positionOf(trades, trade.tradeNumber)
  const held = trades[at]
  if (held?.tradeNumber === trade.tradeNumber) {
    trades[at] = trade
    return held
  }
  trades.splice(at, 0, trade)
  return undefined
}

function removeFrom(
  trades: Array<RunningTrade>,
  number: TradeNumber
): RunningTrade | undefined {
  const at = positionOf(trades, number)
  if (trades[at]?.tradeNumber !== number) return undefined
  return trades.splice(at, 1)[0]
}

function countCode(fold: Fold, code: string, by: 1 | -1) {
  const count = (fold.codes.get(code) ?? 0) + by
  if (count === 0) fold.codes.delete(code)
  else fold.codes.set(code, count)
}

function addToFold(fold: Fold, trade: RunningTrade) {
  fold.value += tradeValue(trade)
  countCode(fold, trade.code, 1)
}

function takeFromFold(fold: Fold, trade: RunningTrade) {
  fold.value -= tradeValue(trade)
  countCode(fold, trade.code, -1)
}

const newestOf = (fold: Fold): TradeNumber => fold.trades.at(-1)!.tradeNumber

function foldFor(tape: Tape, match: AuctionMatch): Fold {
  const held = tape.folds.find((fold) => fold.match === match)
  if (held !== undefined) return held
  const fold: Fold = { match, trades: [], value: 0, codes: new Map() }
  tape.folds.push(fold)
  return fold
}

// Takes a trade number already held out of wherever it sits: a later feed
// can change its board or time, and with them whether it folds.
function takeOut(tape: Tape, number: TradeNumber): boolean {
  if (removeFrom(tape.continuous, number) !== undefined) return true
  for (const fold of tape.folds) {
    const held = removeFrom(fold.trades, number)
    if (held === undefined) continue
    takeFromFold(fold, held)
    return true
  }
  return false
}

function insert(tape: Tape, trade: RunningTrade) {
  const match = auctionMatchOf(trade)
  const known = takeOut(tape, trade.tradeNumber)
  const tooOld =
    tape.evictedThrough !== undefined &&
    TradeNumberOrder(trade.tradeNumber, tape.evictedThrough) <= 0
  if (match === undefined) {
    if (tooOld && !known) return
    place(tape.continuous, trade)
  } else {
    const held = tape.folds.find((fold) => fold.match === match)
    if (tooOld && held === undefined) return
    const fold = held ?? foldFor(tape, match)
    place(fold.trades, trade)
    addToFold(fold, trade)
  }
  if (!known) tape.received += 1
}

// Drops the oldest continuous trades past the cap, then each fold the drop
// passed: a fold leaves once the trades on both sides of it have.
function evict(tape: Tape) {
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
      (through !== undefined && TradeNumberOrder(newestOf(fold), through) < 0)
    if (gone) tape.folds.splice(index, 1)
  }
  tape.folds.sort((a, b) => TradeNumberOrder(newestOf(a), newestOf(b)))
}

// The tape after one viewer message. A snapshot starts it over; a delta's
// trades go in by trade number, a known one replacing what the tape held.
export function applyViewerMessage(tape: Tape, message: ViewerDown): Tape {
  const next = message._tag === "Snapshot" ? emptyTape() : tape
  for (const trade of message.tape) insert(next, trade)
  evict(next)
  return next
}

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

function segmentsOf(
  tape: Tape,
  open: ReadonlySet<AuctionMatch>
): Array<Segment> {
  const segments: Array<Segment> = []
  // `from` counts back from the newest continuous trade.
  let taken = 0
  for (let index = tape.folds.length - 1; index >= 0; index--) {
    const fold = tape.folds[index]!
    const newer =
      tape.continuous.length - positionOf(tape.continuous, newestOf(fold))
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
}

const segmentLength = (segment: Segment): number =>
  segment.kind === "continuous"
    ? segment.length
    : 1 + (segment.open ? segment.fold.trades.length : 0)

export function tapeLength(
  tape: Tape,
  open: ReadonlySet<AuctionMatch>
): number {
  let length = 0
  for (const segment of segmentsOf(tape, open)) length += segmentLength(segment)
  return length
}

// Rows `from` (inclusive) to `to` (exclusive) of the list, newest first.
export function tapeRows(
  tape: Tape,
  open: ReadonlySet<AuctionMatch>,
  from: number,
  to: number
): Array<TapeRow> {
  const rows: Array<TapeRow> = []
  let start = 0
  for (const segment of segmentsOf(tape, open)) {
    const length = segmentLength(segment)
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
            TradeNumberOrder(newestContinuous.tradeNumber, newestOf(fold)) < 0,
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
}
