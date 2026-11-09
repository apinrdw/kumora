// 1-minute candles per stock code and index (spec apinrdw/kumora#138,
// "Candles"). A stock's come from the merged tape's regular-board trades, each
// in the candle of its own minute, so the 08:58 and 16:00 auction matches make
// their own; an index's come from its `liveprice` frames. The trading day
// feeds every inserted or merged trade through `trade` and sends what
// `takeChanged` returns.
import type { Candle, RunningTrade, StockCode } from "@workspace/relay"
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
interface Figures {
  readonly openOrder: bigint
  readonly open: number
  readonly closeOrder: bigint
  readonly close: number
  readonly high: number
  readonly low: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

interface Print {
  readonly order: bigint
  readonly price: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

const add = (figures: Figures | undefined, print: Print): Figures => {
  if (figures === undefined)
    return {
      openOrder: print.order,
      open: print.price,
      closeOrder: print.order,
      close: print.price,
      high: print.price,
      low: print.price,
      volume: print.volume,
      value: print.value,
      frequency: print.frequency,
    }
  const opens = print.order < figures.openOrder
  const closes = print.order > figures.closeOrder
  return {
    openOrder: opens ? print.order : figures.openOrder,
    open: opens ? print.price : figures.open,
    closeOrder: closes ? print.order : figures.closeOrder,
    close: closes ? print.price : figures.close,
    high: Math.max(figures.high, print.price),
    low: Math.min(figures.low, print.price),
    volume: figures.volume + print.volume,
    value: figures.value + print.value,
    frequency: figures.frequency + print.frequency,
  }
}

const printOf = (trade: RunningTrade): Print => ({
  order: BigInt(trade.tradeNumber),
  price: trade.price,
  volume: trade.lots,
  value: trade.price * trade.lots * 100,
  frequency: 1,
})

// One code's candle for one minute: what has settled, plus the trades still
// inside the merge window, by trade number.
interface Slot {
  readonly code: StockCode
  readonly minute: number
  settled: Figures | undefined
  readonly open: Map<string, RunningTrade>
}

const minuteOf = (time: DateTime.Utc) =>
  Math.floor(DateTime.toEpochMillis(time) / MINUTE) * MINUTE

const counts = (trade: RunningTrade) => trade.board === "RG"

// Whether two copies of a trade give its candle the same figures.
const sameCandlePart = (a: RunningTrade, b: RunningTrade) =>
  counts(a) === counts(b) &&
  a.code === b.code &&
  minuteOf(a.time) === minuteOf(b.time) &&
  a.price === b.price &&
  a.lots === b.lots

const candleOf = (slot: Slot): Candle | undefined => {
  let figures = slot.settled
  for (const trade of slot.open.values()) figures = add(figures, printOf(trade))
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
      if (!counts(trade)) continue
      const slot = slotOf(trade.code, minuteOf(trade.time))
      slot.open.delete(tradeNumber)
      slot.settled = add(slot.settled, printOf(trade))
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
      // Shares into lots, like a stock's candle.
      volume: (price.volume - base.volume) / 100,
      value: price.value - base.value,
      frequency: price.frequency - base.frequency,
    })
    changed.add(slot)
  })

  // One code's candles so far, ascending by minute.
  const candlesOf = (code: StockCode) =>
    Effect.sync(() =>
      [...(series.get(code)?.values() ?? [])]
        .sort((a, b) => a.minute - b.minute)
        .flatMap((slot) => candleOf(slot) ?? [])
    )

  // Every candle changed since the last call, of any code.
  const takeChanged = Effect.sync(() => {
    const slots = changed
    changed = new Set()
    return [...slots].flatMap((slot) => candleOf(slot) ?? [])
  })

  const hasChanges = Effect.sync(() => changed.size > 0)

  return { trade, indexPrice, candlesOf, takeChanged, hasChanges }
})
