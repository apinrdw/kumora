// 1-minute candles per stock code and index (spec apinrdw/kumora#138,
// "Candles"). A stock's come from the merged tape's regular-board trades, each
// in the candle of its own minute, so the 08:58 and 16:00 auction matches make
// their own; an index's come from its `liveprice` frames. The trading day
// feeds every inserted or merged trade through `trade` and sends what
// `takeChanged` returns. The book holds a candle only while it is changing;
// the day store holds the rest.
//
// A stock's candle carries its footprint (spec apinrdw/kumora#263): the same
// trades' lots by price and aggressor side, kept, changed, resent and stored
// with it, so a late trade resends both. The footprint row also holds the
// minute's sweeps, grouped again from its trades whenever it is written, and
// a trade that changes them resends the minute's, whole.
import type {
  Candle,
  Footprint,
  MinuteSweeps,
  RunningTrade,
  StockCode,
  Sweep,
  TradeNumber,
} from "@workspace/relay"
import {
  SHARES_PER_LOT,
  TradeNumberOrder,
  joinSweeps,
  sweepsOf,
  MINUTE_MS,
} from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

import {
  addTrade,
  cellsOut,
  copyCells,
  noCells,
  type Cells,
} from "./footprint-cells.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

// Decision: a trade's part in its candle stays open for 5 s after it first
// arrived, so a second feed's copy can still move or reprice it; after that a
// later feed changes only the tape row. The viewer protocol has no removal, so
// an emptied candle stays on the page until the next snapshot. See spec
// apinrdw/kumora#138 ("Merge and dedupe"); apps/e2e/support/clock.ts repeats it.
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

// One stock code's footprint for one minute as the day store holds it.
export interface StoredFootprint {
  readonly code: StockCode
  readonly minute: number
  readonly cells: Cells
}

// One stock code's sweeps for one minute as the day store holds them, with
// the highest trade number they were grouped from.
export interface StoredSweeps {
  readonly sweeps: ReadonlyArray<Sweep>
  readonly lastTrade: bigint
}

// What a flush writes of one stock code's minute: its footprint and sweeps.
export interface FootprintRow extends StoredFootprint, StoredSweeps {}

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
  // A stock's footprint for one minute, and its footprints so far, ascending.
  readonly storedFootprint: (
    code: StockCode,
    minute: number
  ) => Effect.Effect<Cells | undefined>
  readonly storedFootprintsOf: (
    code: StockCode
  ) => Effect.Effect<ReadonlyArray<StoredFootprint>>
  // A stock's sweeps for one minute: a trade numbered above them carries
  // them on.
  readonly storedSweeps: (
    code: StockCode,
    minute: number
  ) => Effect.Effect<StoredSweeps | undefined>
  // A stock's regular-board trades in one minute, ascending by trade number:
  // the book groups a minute's sweeps again from them when a trade numbered
  // below its stored sweeps' last lands in it.
  readonly storedMinuteTrades: (
    code: StockCode,
    minute: number
  ) => Effect.Effect<ReadonlyArray<RunningTrade>>
  // A stock's sweeps so far by minute, ascending.
  readonly storedSweepsOf: (
    code: StockCode
  ) => Effect.Effect<ReadonlyMap<number, ReadonlyArray<Sweep>>>
}

interface Print {
  readonly order: bigint
  readonly price: number
  readonly time: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

// Decision: the candle arithmetic (`single`, `fold`, `add`, `printOf`) stays
// plain functions, not Effects: every 250 ms delta folds each trade still in
// its merge window, and as Effects ingesting 100,000 trades took 2.7 s, not
// 2.4 s. The Effects around it call it inline. See apinrdw/kumora#159.
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
  value: trade.price * trade.lots * SHARES_PER_LOT,
  frequency: 1,
})

// One code's candle and footprint for one minute: what has settled, plus the
// trades still inside the merge window, by trade number. Its sweeps are the
// stored ones (`base`) carried on by the trades settled since the book took
// the minute (`trades`), the whole minute's once a late trade made the book
// read them back. An index's footprint and trades stay empty.
interface Slot {
  readonly code: StockCode
  readonly minute: number
  settled: CandleFigures | undefined
  readonly settledCells: Cells
  base: StoredSweeps
  readonly trades: Map<TradeNumber, RunningTrade>
  readonly open: Map<string, RunningTrade>
}

const NO_SWEEPS: StoredSweeps = { sweeps: [], lastTrade: -1n }

// The start of `time`'s minute, in epoch ms: a candle's key, which the Day
// state fallback and the restart's trade scan share.
export const minuteOf = (time: DateTime.Utc) =>
  Effect.succeed(
    Math.floor(DateTime.toEpochMillis(time) / MINUTE_MS) * MINUTE_MS
  )

const counts = (trade: RunningTrade) => Effect.succeed(trade.board === "RG")

// Whether two copies of a trade give its candle, footprint and sweeps the
// same part: a side one feed left unspecified moves its footprint lots, and
// any other time retimes the sweep it starts or regroups its second's.
const samePart = Effect.fnUntraced(function* (
  a: RunningTrade,
  b: RunningTrade
) {
  return (
    (yield* counts(a)) === (yield* counts(b)) &&
    a.code === b.code &&
    DateTime.toEpochMillis(a.time) === DateTime.toEpochMillis(b.time) &&
    a.price === b.price &&
    a.lots === b.lots &&
    a.side === b.side
  )
})

// What has settled plus the trades still inside the merge window.
const figuresOf = (slot: Slot) =>
  Effect.sync(() => {
    let figures = slot.settled
    for (const trade of slot.open.values())
      figures = add(figures, printOf(trade))
    return figures
  })

const candleFrom = (code: StockCode, minute: number, figures: CandleFigures) =>
  Effect.succeed<Candle>({
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

const candleOf = Effect.fnUntraced(function* (slot: Slot) {
  const figures = yield* figuresOf(slot)
  return figures === undefined
    ? undefined
    : yield* candleFrom(slot.code, slot.minute, figures)
})

// What has settled plus the trades still inside the merge window, by price.
const cellsOf = Effect.fnUntraced(function* (slot: Slot) {
  const cells = yield* copyCells(slot.settledCells)
  for (const trade of slot.open.values()) yield* addTrade(cells, trade)
  return cells
})

const footprintFrom = Effect.fnUntraced(function* (
  code: StockCode,
  minute: number,
  cells: Cells
) {
  return {
    code,
    minute: DateTime.makeUnsafe(minute),
    cells: yield* cellsOut(cells),
  } satisfies Footprint
})

// A slot's footprint, none while no stock trade made it.
const footprintOf = Effect.fnUntraced(function* (slot: Slot) {
  const cells = yield* cellsOf(slot)
  return cells.size === 0
    ? undefined
    : yield* footprintFrom(slot.code, slot.minute, cells)
})

// An index's day totals at its latest frame, so a frame's candle gets only
// what traded since.
interface Totals {
  readonly time: number
  readonly last: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
}

// Decision: the book keeps a candle in memory only while a trade of its is in
// the merge window or its figures changed since the last flush; once written
// it leaves, and a later trade in that minute reads it back from the store.
// Holding the whole day would grow without bound on a Worker. A failed flush
// keeps its candles and trades until the write lands. See apinrdw/kumora#157.
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
  // Those of them whose sweeps a trade changed: an index's candle has none.
  let regrouped = new Set<Slot>()
  // What the next flush writes: trades whose merge window closed, each once,
  // and the candles whose settled figures changed.
  let settledTrades = new Map<string, RunningTrade>()
  let unflushed = new Set<Slot>()
  // The candles and trades a flush took and hasn't written yet.
  let flushing = new Set<Slot>()
  let flushingTrades = new Map<string, RunningTrade>()

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
        settledCells:
          (yield* store.storedFootprint(code, minute)) ?? (yield* noCells),
        base: (yield* store.storedSweeps(code, minute)) ?? NO_SWEEPS,
        trades: new Map(),
        open: new Map(),
      }
      minutes.set(minute, slot)
    }
    return slot
  })

  // A slot's sweeps: what has settled, plus the trades still inside the
  // merge window when `withOpen`. A trade numbered at or below the stored
  // sweeps' last can split one, so the minute's stored trades are read back
  // once and the sweeps grouped whole from then on.
  // Decision: the book reads a minute's trades back only for such a late
  // trade. The trades table has no code index, so that read scans the whole
  // market's minute; a trade numbered above the stored sweeps carries them
  // on instead, and the minute a flush let go of reopens from its row. See
  // spec apinrdw/kumora#263.
  const slotSweeps = Effect.fnUntraced(function* (
    slot: Slot,
    withOpen: boolean
  ) {
    const unsettled = withOpen ? [...slot.open.values()] : []
    const late = (trade: RunningTrade) =>
      BigInt(trade.tradeNumber) <= slot.base.lastTrade
    if (
      slot.base !== NO_SWEEPS &&
      [...slot.trades.values(), ...unsettled].some(late)
    ) {
      for (const trade of yield* store.storedMinuteTrades(
        slot.code,
        slot.minute
      ))
        if (!slot.trades.has(trade.tradeNumber))
          slot.trades.set(trade.tradeNumber, trade)
      slot.base = NO_SWEEPS
    }
    const later = yield* sweepsOf(
      [...slot.trades.values(), ...unsettled].sort((a, b) =>
        TradeNumberOrder(a.tradeNumber, b.tradeNumber)
      )
    )
    return yield* joinSweeps(slot.base.sweeps, later)
  })

  // The highest trade number a slot's settled sweeps were grouped from.
  const lastTradeOf = (slot: Slot) =>
    Effect.sync(() => {
      let last = slot.base.lastTrade
      for (const number of slot.trades.keys()) {
        const value = BigInt(number)
        if (value > last) last = value
      }
      return last
    })

  // Lets a candle go once nothing in the book still refers to it.
  const release = (slot: Slot) =>
    Effect.sync(() => {
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
    })

  const settle = Effect.fnUntraced(function* (now: number) {
    for (const [tradeNumber, arrival] of arrivals) {
      if (arrival.arrivedAt + MERGE_WINDOW > now) return
      arrivals.delete(tradeNumber)
      const { trade } = arrival
      settledTrades.set(tradeNumber, trade)
      if (!(yield* counts(trade))) continue
      const slot = yield* slotOf(trade.code, yield* minuteOf(trade.time))
      slot.open.delete(tradeNumber)
      slot.settled = add(slot.settled, printOf(trade))
      yield* addTrade(slot.settledCells, trade)
      slot.trades.set(trade.tradeNumber, trade)
      unflushed.add(slot)
    }
  })

  // A trade as the tape now holds it: new (`held` undefined), or merged from
  // what it held before. A copy changes its part only inside its merge
  // window.
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
      if (yield* samePart(held, current)) return
      if (yield* counts(held)) {
        const before = yield* slotOf(held.code, yield* minuteOf(held.time))
        before.open.delete(held.tradeNumber)
        changed.add(before)
        regrouped.add(before)
      }
    } else {
      arrivals.set(current.tradeNumber, { arrivedAt: now, trade: current })
    }
    if (!(yield* counts(current))) return
    const slot = yield* slotOf(current.code, yield* minuteOf(current.time))
    slot.open.set(current.tradeNumber, current)
    changed.add(slot)
    regrouped.add(slot)
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
    const slot = yield* slotOf(price.code, yield* minuteOf(price.time))
    slot.settled = add(slot.settled, {
      order: BigInt(time),
      price: last,
      time,
      // Shares into lots, like a stock's candle.
      volume: (price.volume - base.volume) / SHARES_PER_LOT,
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
      const figures = yield* figuresOf(slot)
      if (figures !== undefined) minutes.set(slot.minute, figures)
    }
    return minutes
  })

  // One code's candles so far, ascending by minute.
  const candlesOf = Effect.fnUntraced(function* (code: StockCode) {
    const candles: Array<Candle> = []
    for (const [minute, figures] of [
      ...(yield* candlesAfter(code, undefined)),
    ].sort(([a], [b]) => a - b))
      candles.push(yield* candleFrom(code, minute, figures))
    return candles
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

  // One stock's footprints so far, ascending by minute: the store's with the
  // book's laid over them.
  const footprintsOf = Effect.fnUntraced(function* (code: StockCode) {
    const minutes = new Map<number, Cells>()
    for (const stored of yield* store.storedFootprintsOf(code))
      minutes.set(stored.minute, stored.cells)
    for (const slot of series.get(code)?.values() ?? [])
      minutes.set(slot.minute, yield* cellsOf(slot))
    const footprints: Array<Footprint> = []
    for (const [minute, cells] of [...minutes].sort(([a], [b]) => a - b))
      if (cells.size > 0)
        footprints.push(yield* footprintFrom(code, minute, cells))
    return footprints
  })

  // One stock's sweeps so far, ascending: the store's with the book's
  // minutes laid over them.
  const sweepsOfCode = Effect.fnUntraced(function* (code: StockCode) {
    const minutes = new Map(yield* store.storedSweepsOf(code))
    for (const slot of series.get(code)?.values() ?? [])
      minutes.set(slot.minute, yield* slotSweeps(slot, true))
    return [...minutes]
      .sort(([a], [b]) => a - b)
      .flatMap(([, sweeps]) => sweeps)
  })

  // Every candle changed since the last call, of any code, and of
  // `selected` the footprints among them and each minute's sweeps a trade
  // changed.
  //
  // Decision: a changed minute's sweeps go out whole in every delta and the
  // page replaces its copy, so the book is the only grouper and the join
  // can't gap or double. A peak minute of 370 sweeps measured 21.7 KB in its
  // last delta, 11.0 KB a delta over its 240 (sweeps.test.ts). If too heavy,
  // send a minute's sweeps at most once a second. See apinrdw/kumora#279.
  const takeChanged = Effect.fnUntraced(function* (
    selected: ReadonlySet<StockCode>
  ) {
    const slots = changed
    const resent = regrouped
    changed = new Set()
    regrouped = new Set()
    const candles: Array<Candle> = []
    const footprints: Array<Footprint> = []
    const sweeps: Array<MinuteSweeps> = []
    for (const slot of slots) {
      const candle = yield* candleOf(slot)
      if (candle !== undefined) candles.push(candle)
      if (!selected.has(slot.code)) continue
      const footprint = yield* footprintOf(slot)
      if (footprint !== undefined) footprints.push(footprint)
      if (resent.has(slot))
        sweeps.push({
          code: slot.code,
          minute: DateTime.makeUnsafe(slot.minute),
          sweeps: yield* slotSweeps(slot, true),
        })
    }
    for (const slot of slots) yield* release(slot)
    return { candles, footprints, sweeps }
  })

  const hasChanges = Effect.sync(() => changed.size > 0)

  // A trade still inside its merge window, as the book holds it: a second
  // feed's copy merges into it even once the tape evicted it.
  const openTrade = Effect.fnUntraced(function* (tradeNumber: TradeNumber) {
    yield* settle(yield* Clock.currentTimeMillis)
    return arrivals.get(tradeNumber)?.trade
  })

  // Whether the book holds a trade the store doesn't have yet: inside its
  // merge window, settled since the last flush, or taken by a flush that
  // hasn't landed.
  const holds = (tradeNumber: TradeNumber) =>
    Effect.sync(
      () =>
        arrivals.has(tradeNumber) ||
        settledTrades.has(tradeNumber) ||
        flushingTrades.has(tradeNumber)
    )

  // What a flush writes: the trades whose merge window closed by `now`, and
  // the settled figures of every candle they or an index frame changed,
  // with the trades and candles an earlier flush took but didn't write. At
  // the seal `now` is the end of time: every window closes.
  const takeSettled = Effect.fnUntraced(function* (final: boolean) {
    yield* settle(final ? Infinity : yield* Clock.currentTimeMillis)
    for (const entry of settledTrades) flushingTrades.set(...entry)
    settledTrades = new Map()
    for (const slot of unflushed) flushing.add(slot)
    unflushed = new Set()
    const candles = [...flushing].flatMap((slot) =>
      slot.settled === undefined
        ? []
        : [{ code: slot.code, minute: slot.minute, figures: slot.settled }]
    )
    const footprints: Array<FootprintRow> = []
    for (const slot of flushing)
      if (slot.settledCells.size > 0)
        footprints.push({
          code: slot.code,
          minute: slot.minute,
          cells: slot.settledCells,
          sweeps: yield* slotSweeps(slot, false),
          lastTrade: yield* lastTradeOf(slot),
        })
    return { trades: [...flushingTrades.values()], candles, footprints }
  })

  // The flush that took the last `takeSettled` landed: its trades leave the
  // book, and its candles unless they are changing again.
  const written = Effect.gen(function* () {
    flushingTrades = new Map()
    const slots = flushing
    flushing = new Set()
    for (const slot of slots) yield* release(slot)
  })

  // Whether a flush has anything of the book's to write: trades waiting for
  // their merge window to close, or trades and candles not written yet.
  const hasUnflushed = Effect.sync(
    () =>
      arrivals.size > 0 ||
      settledTrades.size > 0 ||
      flushingTrades.size > 0 ||
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
    footprintsOf,
    sweepsOf: sweepsOfCode,
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
