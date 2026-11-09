// 1-minute candles per stock code and index (spec apinrdw/kumora#138,
// "Candles"). A stock's come from the merged tape's regular-board trades, each
// in the candle of its own minute, so the 08:58 and 16:00 auction matches make
// their own; an index's come from its `liveprice` frames. The trading day
// feeds every inserted or merged trade through `trade` and sends what
// `takeChanged` returns.
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

const candleOf = (slot: Slot): Candle | undefined => {
  const figures = figuresOf(slot)
  if (figures === undefined) return undefined
  return {
    code: slot.code,
    minute: DateTime.makeUnsafe(slot.minute),
    open: figures.open,
    high: figures.high,
    low: figures.low,
    close: figures.close,
    volume: figures.volume,
    value: figures.value,
    frequency: figures.frequency,
  }
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

export const makeCandleBook = Effect.sync(() => {
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

  const slotOf = (code: StockCode, minute: number) => {
    let minutes = series.get(code)
    if (minutes === undefined) {
      minutes = new Map()
      series.set(code, minutes)
    }
    let slot = minutes.get(minute)
    if (slot === undefined) {
      slot = { code, minute, settled: undefined, open: new Map() }
      minutes.set(minute, slot)
    }
    return slot
  }

  const settle = (now: number) => {
    for (const [tradeNumber, arrival] of arrivals) {
      if (arrival.arrivedAt + MERGE_WINDOW > now) return
      arrivals.delete(tradeNumber)
      const { trade } = arrival
      settledTrades.set(tradeNumber, trade)
      if (!counts(trade)) continue
      const slot = slotOf(trade.code, minuteOf(trade.time))
      slot.open.delete(tradeNumber)
      slot.settled = add(slot.settled, printOf(trade))
      unflushed.add(slot)
    }
  }

  // A trade as the tape now holds it: new (`held` undefined), or merged from
  // what it held before.
  const trade = Effect.fnUntraced(function* (
    held: RunningTrade | undefined,
    current: RunningTrade
  ) {
    const now = yield* Clock.currentTimeMillis
    settle(now)
    const arrival = arrivals.get(current.tradeNumber)
    if (held !== undefined) {
      if (arrival === undefined) return
      arrival.trade = current
      if (sameCandlePart(held, current)) return
      if (counts(held)) {
        const before = slotOf(held.code, minuteOf(held.time))
        before.open.delete(held.tradeNumber)
        changed.add(before)
      }
    } else {
      arrivals.set(current.tradeNumber, { arrivedAt: now, trade: current })
    }
    if (!counts(current)) return
    const slot = slotOf(current.code, minuteOf(current.time))
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
    const slot = slotOf(price.code, minuteOf(price.time))
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

  // One code's candles so far, ascending by minute.
  const candlesOf = (code: StockCode) =>
    Effect.sync(() =>
      [...(series.get(code)?.values() ?? [])]
        .sort((a, b) => a.minute - b.minute)
        .flatMap((slot) => candleOf(slot) ?? [])
    )

  // One code's candles for the minutes after `minute`, folded into one; the
  // Day state fallback carries a `liveprice` frame on by them.
  const foldAfter = (code: StockCode, minute: number) =>
    Effect.sync(() => {
      let folded: CandleFigures | undefined
      for (const slot of series.get(code)?.values() ?? []) {
        if (slot.minute <= minute) continue
        const figures = figuresOf(slot)
        if (figures === undefined) continue
        folded = folded === undefined ? figures : fold(folded, figures)
      }
      return folded
    })

  // Every candle changed since the last call, of any code.
  const takeChanged = Effect.sync(() => {
    const slots = changed
    changed = new Set()
    return [...slots].flatMap((slot) => candleOf(slot) ?? [])
  })

  const hasChanges = Effect.sync(() => changed.size > 0)

  // A trade still inside its merge window, as the book holds it: a second
  // feed's copy merges into it even once the tape evicted it.
  const openTrade = Effect.fnUntraced(function* (tradeNumber: TradeNumber) {
    settle(yield* Clock.currentTimeMillis)
    return arrivals.get(tradeNumber)?.trade
  })

  // Whether the book holds a trade the store doesn't have yet: inside its
  // merge window, or settled since the last flush.
  const holds = (tradeNumber: TradeNumber) =>
    Effect.sync(
      () => arrivals.has(tradeNumber) || settledTrades.has(tradeNumber)
    )

  // What a flush writes: the trades whose merge window closed by `now`, and
  // the settled figures of every candle they or an index frame changed. At
  // the seal `now` is the end of time: every window closes.
  const takeSettled = Effect.fnUntraced(function* (final: boolean) {
    settle(final ? Infinity : yield* Clock.currentTimeMillis)
    const trades = [...settledTrades.values()]
    const candles = [...unflushed].flatMap((slot) =>
      slot.settled === undefined
        ? []
        : [{ code: slot.code, minute: slot.minute, figures: slot.settled }]
    )
    settledTrades = new Map()
    unflushed = new Set()
    return { trades, candles }
  })

  // Trades still waiting for their merge window to close.
  const hasUnsettled = Effect.sync(() => arrivals.size > 0)

  // A restarted object's stored candles, and its indices' last frames, so new
  // trades and frames add to them.
  const restore = (
    stored: ReadonlyArray<{
      readonly code: StockCode
      readonly minute: number
      readonly figures: CandleFigures
    }>,
    indexPrices: ReadonlyArray<LivePrice>
  ) =>
    Effect.sync(() => {
      for (const { code, minute, figures } of stored)
        slotOf(code, minute).settled = figures
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
    hasUnsettled,
    restore,
  }
})
