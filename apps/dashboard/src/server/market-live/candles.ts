// 1-minute candles per stock code and index (spec apinrdw/kumora#138,
// "Candles"). A stock's come from the merged tape's regular-board trades, each
// in the candle of its own minute, so the 08:58 and 16:00 auction matches make
// their own; an index's come from its `liveprice` frames. The trading day
// feeds every inserted or merged trade through `trade` and sends what
// `takeChanged` returns. The book holds a candle only while it is changing;
// the day store holds the rest.
import type {
  Candle,
  RunningTrade,
  StockCode,
  TradeNumber,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

import type { LivePrice } from "./stockbit-liveprice.ts"

const MINUTE = 60_000

// Decision: a trade's part in its candle stays open for 5 s after the trade
// first arrived, the merge window of spec apinrdw/kumora#138 ("Merge and
// dedupe"): a second feed's copy can still move it to another minute (Ajaib
// rounds to the second), another board, or change its price. After that it is
// folded in for good, and a later feed changes only the tape row. A candle
// whose every trade moved away keeps its last sent figures on the page until
// the next snapshot: the viewer protocol has no removal.
const MERGE_WINDOW = 5_000

// A candle's figures. Open and close belong to the trades with the lowest and
// highest order: the trade number for a stock, the frame time for an index.
// The close's time is its trade's, in epoch ms.
export interface CandleFigures {
  readonly openOrder: bigint
  readonly open: number
  readonly closeOrder: bigint
  readonly close: number
  readonly closeTime: number
  readonly high: number
  readonly low: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

// One code's candle for one minute as the day store holds it, with the trade
// numbers (or, for an index, the frame times) its open and close came from,
// so the book keeps adding to it.
export interface StoredCandle {
  readonly code: StockCode
  readonly minute: number
  readonly figures: CandleFigures
}

// The settled candles the day store holds: the book reads one back when a
// trade lands in a minute it let go of, and a code's candles so far when a
// snapshot or the Day state fallback asks for them.
export interface SettledCandles {
  readonly storedCandle: (
    code: StockCode,
    minute: number
  ) => Effect.Effect<CandleFigures | undefined>
  // One code's candles after `after`, every one when undefined, ascending.
  readonly storedCandlesOf: (
    code: StockCode,
    after?: number
  ) => Effect.Effect<ReadonlyArray<StoredCandle>>
}

interface Print {
  readonly order: bigint
  readonly price: number
  readonly time: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

const single = (print: Print): CandleFigures => ({
  openOrder: print.order,
  open: print.price,
  closeOrder: print.order,
  close: print.price,
  closeTime: print.time,
  high: print.price,
  low: print.price,
  volume: print.volume,
  value: print.value,
  frequency: print.frequency,
})

// Two sets of figures as one: the earlier open, the later close, the range
// and the sums of both.
const fold = (a: CandleFigures, b: CandleFigures): CandleFigures => {
  const opens = b.openOrder < a.openOrder
  const closes = b.closeOrder > a.closeOrder
  return {
    openOrder: opens ? b.openOrder : a.openOrder,
    open: opens ? b.open : a.open,
    closeOrder: closes ? b.closeOrder : a.closeOrder,
    close: closes ? b.close : a.close,
    closeTime: closes ? b.closeTime : a.closeTime,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    volume: a.volume + b.volume,
    value: a.value + b.value,
    frequency: a.frequency + b.frequency,
  }
}

const add = (figures: CandleFigures | undefined, print: Print) =>
  figures === undefined ? single(print) : fold(figures, single(print))

const printOf = (trade: RunningTrade): Print => ({
  order: BigInt(trade.tradeNumber),
  price: trade.price,
  time: DateTime.toEpochMillis(trade.time),
  volume: trade.lots,
  value: trade.price * trade.lots * 100,
  frequency: 1,
})

// One code's candle for one minute: what has settled, plus the trades still
// inside the merge window, by trade number.
interface Slot {
  readonly code: StockCode
  readonly minute: number
  settled: CandleFigures | undefined
  readonly open: Map<string, RunningTrade>
}

// The start of `time`'s minute, in epoch ms: a candle's key, which the Day
// state fallback and the restart's trade scan share.
export const minuteOf = (time: DateTime.Utc) =>
  Math.floor(DateTime.toEpochMillis(time) / MINUTE) * MINUTE

const counts = (trade: RunningTrade) => trade.board === "RG"

// Whether two copies of a trade give its candle the same figures.
const sameCandlePart = (a: RunningTrade, b: RunningTrade) =>
  counts(a) === counts(b) &&
  a.code === b.code &&
  minuteOf(a.time) === minuteOf(b.time) &&
  a.price === b.price &&
  a.lots === b.lots

// What has settled plus the trades still inside the merge window.
const figuresOf = (slot: Slot) => {
  let figures = slot.settled
  for (const trade of slot.open.values()) figures = add(figures, printOf(trade))
  return figures
}

const candleFrom = (
  code: StockCode,
  minute: number,
  figures: CandleFigures
): Candle => ({
  code,
  minute: DateTime.makeUnsafe(minute),
  open: figures.open,
  high: figures.high,
  low: figures.low,
  close: figures.close,
  volume: figures.volume,
  value: figures.value,
  frequency: figures.frequency,
})

const candleOf = (slot: Slot): Candle | undefined => {
  const figures = figuresOf(slot)
  return figures === undefined
    ? undefined
    : candleFrom(slot.code, slot.minute, figures)
}

// An index's day totals at its latest frame, so a frame's candle gets only
// what traded since.
interface Totals {
  readonly time: number
  readonly last: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

// Decision: the book keeps a candle in memory only while it is changing: a
// trade of its is inside the merge window, or its settled figures changed
// since the last flush. Once the flush that took it has written it, the
// candle leaves the book, and a trade that lands in that minute later reads
// the figures back from the store first. So the book holds about a minute of
// the day, bounded by the codes trading in it, however long the day runs
// (CODING_STANDARDS.md, "Bounded memory on a Worker"); a code's candles so
// far are read from the store when a snapshot or the Day state fallback asks,
// and a restart reads nothing back. A flush that fails leaves its candles in
// the book, and the next flush writes them again, with the trades the failed
// one took (trading-day.ts).
export const makeCandleBook = Effect.fnUntraced(function* (
  store: SettledCandles
) {
  const series = new Map<StockCode, Map<number, Slot>>()
  // Trades still inside the merge window, in arrival order.
  const arrivals = new Map<
    string,
    { readonly arrivedAt: number; trade: RunningTrade }
  >()
  const indexTotals = new Map<StockCode, Totals>()
  let changed = new Set<Slot>()
  // What the next flush writes: trades whose merge window closed, each once,
  // and the candles whose settled figures changed.
  let settledTrades = new Map<string, RunningTrade>()
  let unflushed = new Set<Slot>()
  // The candles a flush took and hasn't written yet.
  let flushing = new Set<Slot>()

  const slotOf = Effect.fnUntraced(function* (code: StockCode, minute: number) {
    let minutes = series.get(code)
    if (minutes === undefined) {
      minutes = new Map()
      series.set(code, minutes)
    }
    let slot = minutes.get(minute)
    if (slot === undefined) {
      slot = {
        code,
        minute,
        settled: yield* store.storedCandle(code, minute),
        open: new Map(),
      }
      minutes.set(minute, slot)
    }
    return slot
  })

  // Lets a candle go once nothing in the book still refers to it.
  const release = (slot: Slot) => {
    if (
      slot.open.size > 0 ||
      unflushed.has(slot) ||
      flushing.has(slot) ||
      changed.has(slot)
    )
      return
    const minutes = series.get(slot.code)
    if (minutes?.get(slot.minute) !== slot) return
    minutes.delete(slot.minute)
    if (minutes.size === 0) series.delete(slot.code)
  }

  const settle = Effect.fnUntraced(function* (now: number) {
    for (const [tradeNumber, arrival] of arrivals) {
      if (arrival.arrivedAt + MERGE_WINDOW > now) return
      arrivals.delete(tradeNumber)
      const { trade } = arrival
      settledTrades.set(tradeNumber, trade)
      if (!counts(trade)) continue
      const slot = yield* slotOf(trade.code, minuteOf(trade.time))
      slot.open.delete(tradeNumber)
      slot.settled = add(slot.settled, printOf(trade))
      unflushed.add(slot)
    }
  })

  // A trade as the tape now holds it: new (`held` undefined), or merged from
  // what it held before.
  const trade = Effect.fnUntraced(function* (
    held: RunningTrade | undefined,
    current: RunningTrade
  ) {
    const now = yield* Clock.currentTimeMillis
    yield* settle(now)
    const arrival = arrivals.get(current.tradeNumber)
    if (held !== undefined) {
      if (arrival === undefined) return
      arrival.trade = current
      if (sameCandlePart(held, current)) return
      if (counts(held)) {
        const before = yield* slotOf(held.code, minuteOf(held.time))
        before.open.delete(held.tradeNumber)
        changed.add(before)
      }
    } else {
      arrivals.set(current.tradeNumber, { arrivedAt: now, trade: current })
    }
    if (!counts(current)) return
    const slot = yield* slotOf(current.code, minuteOf(current.time))
    slot.open.set(current.tradeNumber, current)
    changed.add(slot)
  })

  // An index's `liveprice` frame. Its candle moves by the day totals' growth
  // since the frame before; the first frame seen sets the base, so the volume
  // before the relay started isn't piled onto one minute. A frame without a
  // last price keeps the one before, and a frame older than the latest is
  // dropped.
  const indexPrice = Effect.fnUntraced(function* (price: LivePrice) {
    const time = DateTime.toEpochMillis(price.time)
    const before = indexTotals.get(price.code)
    if (before !== undefined && time <= before.time) return
    const last = price.last ?? before?.last
    if (last === undefined) return
    const totals: Totals = {
      time,
      last,
      volume: price.volume,
      value: price.value,
      frequency: price.frequency,
    }
    const base = before ?? totals
    indexTotals.set(price.code, totals)
    const slot = yield* slotOf(price.code, minuteOf(price.time))
    slot.settled = add(slot.settled, {
      order: BigInt(time),
      price: last,
      time,
      // Shares into lots, like a stock's candle.
      volume: (price.volume - base.volume) / 100,
      value: price.value - base.value,
      frequency: price.frequency - base.frequency,
    })
    changed.add(slot)
    unflushed.add(slot)
  })

  // One code's figures for the minutes after `after`, every minute when
  // undefined: the store's candles with the book's laid over them, by minute.
  const candlesAfter = Effect.fnUntraced(function* (
    code: StockCode,
    after: number | undefined
  ) {
    const minutes = new Map<number, CandleFigures>()
    for (const stored of yield* store.storedCandlesOf(code, after))
      minutes.set(stored.minute, stored.figures)
    for (const slot of series.get(code)?.values() ?? []) {
      if (after !== undefined && slot.minute <= after) continue
      const figures = figuresOf(slot)
      if (figures !== undefined) minutes.set(slot.minute, figures)
    }
    return minutes
  })

  // One code's candles so far, ascending by minute.
  const candlesOf = Effect.fnUntraced(function* (code: StockCode) {
    return [...(yield* candlesAfter(code, undefined))]
      .sort(([a], [b]) => a - b)
      .map(([minute, figures]) => candleFrom(code, minute, figures))
  })

  // One code's candles for the minutes after `minute`, every minute when
  // undefined, folded into one; the Day state fallback carries a `liveprice`
  // frame on by them.
  const foldAfter = Effect.fnUntraced(function* (
    code: StockCode,
    minute: number | undefined
  ) {
    let folded: CandleFigures | undefined
    for (const figures of (yield* candlesAfter(code, minute)).values())
      folded = folded === undefined ? figures : fold(folded, figures)
    return folded
  })

  // Every candle changed since the last call, of any code.
  const takeChanged = Effect.sync(() => {
    const slots = changed
    changed = new Set()
    const candles = [...slots].flatMap((slot) => candleOf(slot) ?? [])
    for (const slot of slots) release(slot)
    return candles
  })

  const hasChanges = Effect.sync(() => changed.size > 0)

  // A trade still inside its merge window, as the book holds it: a second
  // feed's copy merges into it even once the tape evicted it.
  const openTrade = Effect.fnUntraced(function* (tradeNumber: TradeNumber) {
    yield* settle(yield* Clock.currentTimeMillis)
    return arrivals.get(tradeNumber)?.trade
  })

  // Whether the book holds a trade the store doesn't have yet: inside its
  // merge window, or settled since the last flush.
  const holds = (tradeNumber: TradeNumber) =>
    Effect.sync(
      () => arrivals.has(tradeNumber) || settledTrades.has(tradeNumber)
    )

  // What a flush writes: the trades whose merge window closed by `now`, and
  // the settled figures of every candle they or an index frame changed,
  // with those an earlier flush took but didn't write. At the seal `now` is
  // the end of time: every window closes.
  const takeSettled = Effect.fnUntraced(function* (final: boolean) {
    yield* settle(final ? Infinity : yield* Clock.currentTimeMillis)
    const trades = [...settledTrades.values()]
    for (const slot of unflushed) flushing.add(slot)
    unflushed = new Set()
    const candles = [...flushing].flatMap((slot) =>
      slot.settled === undefined
        ? []
        : [{ code: slot.code, minute: slot.minute, figures: slot.settled }]
    )
    settledTrades = new Map()
    return { trades, candles }
  })

  // The flush that took the last `takeSettled` landed: its candles leave the
  // book unless they are changing again.
  const written = Effect.sync(() => {
    const slots = flushing
    flushing = new Set()
    for (const slot of slots) release(slot)
  })

  // Whether a flush has anything of the book's to write: trades waiting for
  // their merge window to close, or candles not written yet.
  const hasUnflushed = Effect.sync(
    () =>
      arrivals.size > 0 ||
      settledTrades.size > 0 ||
      unflushed.size > 0 ||
      flushing.size > 0
  )

  // A restarted object's indices' last frames, so new frames add to them.
  const restore = (indexPrices: ReadonlyArray<LivePrice>) =>
    Effect.sync(() => {
      for (const price of indexPrices) {
        if (!price.isIndex || price.last === undefined) continue
        indexTotals.set(price.code, {
          time: DateTime.toEpochMillis(price.time),
          last: price.last,
          volume: price.volume,
          value: price.value,
          frequency: price.frequency,
        })
      }
    })

  // How many candles the book holds: the bound's measure.
  const retained = Effect.sync(() => {
    let count = 0
    for (const minutes of series.values()) count += minutes.size
    return count
  })

  return {
    trade,
    indexPrice,
    candlesOf,
    foldAfter,
    takeChanged,
    hasChanges,
    openTrade,
    holds,
    takeSettled,
    written,
    hasUnflushed,
    restore,
    retained,
  }
})
