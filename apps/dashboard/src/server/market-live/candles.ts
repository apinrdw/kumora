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
  SweepAlert,
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
import { makeSweepAlerts, type KnownSweep } from "./sweep-alerts.ts"

// Decision: a trade's part in its candle stays open for 5 s after it first
// arrived, so a second feed's copy can still move or reprice it; after that a
// later feed changes only the tape row. A minute such a copy emptied goes out
// as a footprint with no cells and no candle (`takeChanged`). See spec
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
  // The value of the trades whose aggressor side is buy, and sell.
  readonly buyValue: number
  readonly sellValue: number
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
  // Every stock's sweeps, a minute at a time in no order, each handed to
  // `each` as it is read.
  readonly eachStoredSweeps: (
    each: (code: StockCode, sweeps: ReadonlyArray<Sweep>) => Effect.Effect<void>
  ) => Effect.Effect<void>
}

interface Print {
  readonly order: bigint
  readonly price: number
  readonly time: number
  readonly volume: number
  readonly value: number
  readonly buyValue: number
  readonly sellValue: number
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
  buyValue: print.buyValue,
  sellValue: print.sellValue,
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
    buyValue: a.buyValue + b.buyValue,
    sellValue: a.sellValue + b.sellValue,
    frequency: a.frequency + b.frequency,
  }
}

const add = (figures: CandleFigures | undefined, print: Print) =>
  figures === undefined ? single(print) : fold(figures, single(print))

// A trade's value by side; tape.ts `REBUILD_CANDLE_SIDES` repeats this
// rule in SQL.
const printOf = (trade: RunningTrade): Print => {
  const value = trade.price * trade.lots * SHARES_PER_LOT
  return {
    order: BigInt(trade.tradeNumber),
    price: trade.price,
    time: DateTime.toEpochMillis(trade.time),
    volume: trade.lots,
    value,
    buyValue: trade.side === "buy" ? value : 0,
    sellValue: trade.side === "sell" ? value : 0,
    frequency: 1,
  }
}

// One code's candle figures from its regular-board trades in one minute, as
// the book would fold them: a walked day's build (order-flow-build.ts).
export const figuresOfTrades = (trades: ReadonlyArray<RunningTrade>) =>
  Effect.sync(() => {
    let figures: CandleFigures | undefined
    for (const trade of trades) figures = add(figures, printOf(trade))
    return figures
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
  // The sweeps the store held when the book took the minute, as the alert
  // rule knows them (`knownSweeps`).
  readonly stored: ReadonlyArray<KnownSweep>
  base: StoredSweeps
  readonly trades: Map<TradeNumber, RunningTrade>
  // Each of `trades` that was read back from the store, with the first trade
  // of the stored sweep it was in.
  readonly storedIn: Map<TradeNumber, TradeNumber>
  readonly open: Map<string, RunningTrade>
}

const NO_SWEEPS: StoredSweeps = { sweeps: [], lastTrade: -1n }

// The start of `time`'s minute, in epoch ms: a candle's key, which the Day
// state fallback and the restart's trade scan share.
export const minuteOf = (time: DateTime.Utc) =>
  Effect.succeed(
    Math.floor(DateTime.toEpochMillis(time) / MINUTE_MS) * MINUTE_MS
  )

// Whether a trade counts toward its candle; tape.ts
// `REBUILD_CANDLE_SIDES` repeats this filter in SQL.
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

export const candleFrom = (
  code: StockCode,
  minute: number,
  figures: CandleFigures
) =>
  Effect.succeed<Candle>({
    code,
    minute: DateTime.makeUnsafe(minute),
    open: figures.open,
    high: figures.high,
    low: figures.low,
    close: figures.close,
    volume: figures.volume,
    value: figures.value,
    buyValue: figures.buyValue,
    sellValue: figures.sellValue,
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
//
// `settled` hears each regular-board trade as it settles into its candle:
// the minute's settled figures and the trade's own (bubble-book.ts).
export const makeCandleBook = Effect.fnUntraced(function* (
  store: SettledCandles,
  settled: (
    code: StockCode,
    minute: number,
    candle: CandleFigures,
    print: CandleFigures
  ) => void
) {
  const series = new Map<StockCode, Map<number, Slot>>()
  // Trades still inside the merge window, in arrival order.
  const arrivals = new Map<
    string,
    { readonly arrivedAt: number; trade: RunningTrade }
  >()
  const indexTotals = new Map<StockCode, Totals>()
  let changed = new Set<Slot>()
  // Those of them a trade changed, whose footprint and sweeps go out: an
  // index's candle has neither.
  let regrouped = new Set<Slot>()
  // What the next flush writes: trades whose merge window closed, each once,
  // and the candles whose settled figures changed.
  let settledTrades = new Map<string, RunningTrade>()
  let unflushed = new Set<Slot>()
  // The candles and trades a flush took and hasn't written yet.
  let flushing = new Set<Slot>()
  let flushingTrades = new Map<string, RunningTrade>()
  const alertRule = yield* makeSweepAlerts
  // The latest time of any trade the book heard, in epoch ms: a sweep's
  // second has closed once it is later.
  let latest = -Infinity

  const slotOf = Effect.fnUntraced(function* (code: StockCode, minute: number) {
    let minutes = series.get(code)
    if (minutes === undefined) {
      minutes = new Map()
      series.set(code, minutes)
    }
    let slot = minutes.get(minute)
    if (slot === undefined) {
      const base = (yield* store.storedSweeps(code, minute)) ?? NO_SWEEPS
      slot = {
        code,
        minute,
        settled: yield* store.storedCandle(code, minute),
        settledCells:
          (yield* store.storedFootprint(code, minute)) ?? (yield* noCells),
        stored: base.sweeps.map((sweep) => ({
          sweep,
          trades: [sweep.firstTrade],
        })),
        base,
        trades: new Map(),
        storedIn: new Map(),
        open: new Map(),
      }
      minutes.set(minute, slot)
    }
    return slot
  })

  // The minute's stored trades read back into a slot that carried its stored
  // sweeps on, each noted with the stored sweep it was in: the one that
  // starts last at or before it. The slot groups the minute whole from then
  // on.
  const readBack = Effect.fnUntraced(function* (slot: Slot) {
    const stored = slot.base.sweeps
    let index = 0
    for (const trade of yield* store.storedMinuteTrades(
      slot.code,
      slot.minute
    )) {
      if (slot.trades.has(trade.tradeNumber)) continue
      slot.trades.set(trade.tradeNumber, trade)
      while (
        index + 1 < stored.length &&
        TradeNumberOrder(stored[index + 1]!.firstTrade, trade.tradeNumber) <= 0
      )
        index += 1
      const sweep = stored[index]
      if (sweep !== undefined)
        slot.storedIn.set(trade.tradeNumber, sweep.firstTrade)
    }
    slot.base = NO_SWEEPS
  })

  // A slot's sweeps, and the trades it grouped after the stored sweeps it
  // carries on, by trade number: what has settled, plus the trades still
  // inside the merge window when `withOpen`. A trade numbered at or below
  // the stored sweeps' last can split one, so the minute's stored trades are
  // read back once and the sweeps grouped whole from then on.
  // Decision: the book reads a minute's trades back only for such a late
  // trade. The trades table has no code index, so that read scans the whole
  // market's minute; a trade numbered above the stored sweeps carries them
  // on instead, and the minute a flush let go of reopens from its row. See
  // spec apinrdw/kumora#263.
  const groupSlot = Effect.fnUntraced(function* (
    slot: Slot,
    withOpen: boolean
  ) {
    const unsettled = withOpen ? [...slot.open.values()] : []
    const late = (trade: RunningTrade) =>
      BigInt(trade.tradeNumber) <= slot.base.lastTrade
    if (
      slot.base !== NO_SWEEPS &&
      [...slot.trades.values(), ...unsettled].some(late)
    )
      yield* readBack(slot)
    const trades = [...slot.trades.values(), ...unsettled].sort((a, b) =>
      TradeNumberOrder(a.tradeNumber, b.tradeNumber)
    )
    return {
      trades,
      sweeps: yield* joinSweeps(slot.base.sweeps, yield* sweepsOf(trades)),
    }
  })

  const slotSweeps = (slot: Slot, withOpen: boolean) =>
    Effect.map(groupSlot(slot, withOpen), ({ sweeps }) => sweeps)

  // A slot's sweeps as the alert rule knows them (sweep-alerts.ts,
  // `KnownSweep`), open trades included: each with the numbers its trades go
  // by. A trade the book holds goes by its own number. A stored sweep the
  // book carries on goes by its first trade's, all the book has of it. Once
  // the book reads the minute back, each trade that was in a stored sweep
  // goes by that sweep's first trade's number as well as its own, so the
  // rule finds the sweep it ranked in whichever sweeps its trades end up.
  const knownSweeps = Effect.fnUntraced(function* (slot: Slot) {
    const { trades, sweeps } = yield* groupSlot(slot, true)
    // The carried sweeps come first, the last joined by the slot's first
    // trades when they share its side and second; each sweep after takes its
    // trades in turn.
    let taken = 0
    return sweeps.map((sweep, index): KnownSweep => {
      const carried = slot.base.sweeps[index]
      const from = taken
      taken += sweep.trades - (carried?.trades ?? 0)
      return {
        sweep,
        trades: [
          ...(carried === undefined ? [] : [carried.firstTrade]),
          ...trades.slice(from, taken).flatMap(({ tradeNumber }) => {
            const first = slot.storedIn.get(tradeNumber)
            return first === undefined ? [tradeNumber] : [tradeNumber, first]
          }),
        ],
      }
    })
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

  // Lets a candle go once nothing in the book still refers to it: the store
  // holds it, its sweeps as the alert rule last heard them.
  const release = Effect.fnUntraced(function* (slot: Slot) {
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
    yield* alertRule.release(slot.code, slot.minute)
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
      const print = single(printOf(trade))
      slot.settled =
        slot.settled === undefined ? print : fold(slot.settled, print)
      settled(slot.code, slot.minute, slot.settled, print)
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
    latest = Math.max(latest, DateTime.toEpochMillis(current.time))
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
      buyValue: 0,
      sellValue: 0,
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

  // The numbers of an alerting sweep's trades: its minute's from its first
  // trade on, as many as it holds. The book holds them, unless the sweep is
  // a stored one its slot carries on, or the book let the minute go since
  // they arrived: the rule decides a sweep that waited for its second to
  // close whenever a later trade comes. The store has the trades then.
  const tradeNumbersOf = Effect.fnUntraced(function* ({
    code,
    minute,
    sweep,
  }: {
    readonly code: StockCode
    readonly minute: number
    readonly sweep: Sweep
  }) {
    const slot = series.get(code)?.get(minute)
    const first = BigInt(sweep.firstTrade)
    const numbers = new Set<TradeNumber>()
    const take = (trades: Iterable<RunningTrade>) => {
      for (const { tradeNumber } of trades)
        if (BigInt(tradeNumber) >= first) numbers.add(tradeNumber)
    }
    take(slot?.trades.values() ?? [])
    take(slot?.open.values() ?? [])
    if (slot === undefined || first <= slot.base.lastTrade)
      take(yield* store.storedMinuteTrades(code, minute))
    return [...numbers].sort(TradeNumberOrder).slice(0, sweep.trades)
  })

  // Each minute's sweeps grouped again, every code's, and the alert rule's
  // decisions since: on these and on the sweeps that waited for their second
  // to close.
  // Decision: every code's changed minutes are grouped on every delta, with
  // no once-a-second cap, so an alert goes out ~250 ms after its second
  // closes. The 09:00 WIB peak measured 2.2–2.6 ms a delta at p50, 12.7 ms
  // at worst; if deltas run long at the open, group every code at most once
  // a second. See apinrdw/kumora#506.
  const regroupAll = Effect.fnUntraced(function* (slots: ReadonlySet<Slot>) {
    const now = yield* Clock.currentTimeMillis
    const sweeps = new Map<Slot, ReadonlyArray<Sweep>>()
    for (const slot of slots) {
      const minute = yield* knownSweeps(slot)
      sweeps.set(
        slot,
        minute.map(({ sweep }) => sweep)
      )
      yield* alertRule.regroup({
        code: slot.code,
        minute: slot.minute,
        stored: slot.stored,
        sweeps: minute,
      })
    }
    const alerts: Array<SweepAlert> = []
    for (const alert of yield* alertRule.decide({ latest, now }))
      alerts.push({
        code: alert.code,
        side: alert.sweep.side,
        lots: alert.sweep.lots,
        tradeNumbers: yield* tradeNumbersOf(alert),
      })
    return { sweeps, alerts }
  })

  // Every candle changed since the last call, of any code; of `selected`
  // each minute a trade changed: its footprint and its sweeps; and of any
  // code each minute its last regular-board trade left: a footprint with
  // no cells; and of any code the sweep alerts decided since (`regroupAll`).
  // Only the alert rule sees every code's sweeps.
  //
  // Decision: a minute whose last regular-board trade left it goes out as a
  // footprint with no cells, for any code, as its sweeps go out empty, and
  // with no candle. The pages drop that minute (candle-store.ts, and Market
  // Bubbles' lib/bubbles.ts), so the protocol needs no removal message. See
  // apinrdw/kumora#279 and apinrdw/kumora#436.
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
    const grouped = yield* regroupAll(resent)
    const candles: Array<Candle> = []
    const footprints: Array<Footprint> = []
    const sweeps: Array<MinuteSweeps> = []
    for (const slot of slots) {
      const candle = yield* candleOf(slot)
      if (candle !== undefined) candles.push(candle)
      const whole = selected.has(slot.code) && resent.has(slot)
      if (whole || candle === undefined)
        footprints.push(
          yield* footprintFrom(slot.code, slot.minute, yield* cellsOf(slot))
        )
      if (!whole) continue
      sweeps.push({
        code: slot.code,
        minute: DateTime.makeUnsafe(slot.minute),
        sweeps: grouped.sweeps.get(slot) ?? [],
      })
    }
    for (const slot of slots) yield* release(slot)
    return { candles, footprints, sweeps, sweepAlerts: grouped.alerts }
  })

  const hasChanges = Effect.sync(() => changed.size > 0)

  // A trade still inside its merge window, as the book holds it: a second
  // feed's copy merges into it even once the tape evicted it.
  const openTrade = Effect.fnUntraced(function* (tradeNumber: TradeNumber) {
    yield* settle(yield* Clock.currentTimeMillis)
    return arrivals.get(tradeNumber)?.trade
  })

  // The instant, in epoch ms, every trade that reached the book before has
  // settled, and `settled` heard it: the oldest arrival still in its merge
  // window, or now with none. Arrivals settle in arrival order.
  const settledBefore = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* settle(now)
    for (const { arrivedAt } of arrivals.values()) return arrivedAt
    return now
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

  // A restarted object's stored sweeps, every code's, ranked for the alert
  // rule before it decides again, so each side's warm-up and cutoff carry
  // on. The rule counts the stored sweeps of a minute the book takes from
  // the store as ranked (`regroupAll`).
  // Decision: the ranking is rebuilt from the footprints table once, not
  // stored on its own: the research put it at a few MB, under ~30 MB at
  // worst, and the worst day's retains 12 MiB (sweep-alerts-memory.test.ts).
  // See spec apinrdw/kumora#510 and apinrdw/kumora#500.
  const rankStored = store.eachStoredSweeps(alertRule.rank)

  // A code side's sweeps as the alert rule ranks them: the measure of what a
  // restart must rebuild.
  const sweepRanking = alertRule.ranked

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
    settledBefore,
    holds,
    takeSettled,
    written,
    hasUnflushed,
    restore,
    rankStored,
    sweepRanking,
    retained,
  }
})
