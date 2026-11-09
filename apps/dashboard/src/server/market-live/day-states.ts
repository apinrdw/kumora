// Every code's Day state (spec apinrdw/kumora#138, "Day state" and "Starting
// values"): the last Stockbit `liveprice` frame per code, which carries the
// day's totals so far, and, while Stockbit's feed is lost, those figures
// carried on by the merged tape's regular-board trades and Ajaib's `PRICE`.
import {
  TradeNumberOrder,
  type DayState,
  type RunningTrade,
  type StockCode,
  type TradeNumber,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { AjaibPrice } from "./ajaib-price.ts"
import type { CandleFigures } from "./candles.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

const MINUTE = 60_000

// A code's figures as of its last `liveprice` frame, the fallback's base.
interface Base {
  readonly last: number
  readonly previousClose: number
  readonly change: number | undefined
  readonly changePercent: number | undefined
  readonly open: number
  readonly high: number
  readonly low: number
  // Lots.
  readonly volume: number
  readonly value: number
  readonly frequency: number
  readonly time: DateTime.Utc
}

// One regular-board trade kept whole, as much of it as the figures need.
interface Kept {
  readonly number: TradeNumber
  readonly price: number
  readonly lots: number
  readonly time: DateTime.Utc
}

// A code's kept trades of one minute, ascending by trade number.
interface KeptMinute {
  readonly minute: number
  readonly trades: Array<Kept>
}

// What the trades since a base add to it: their range and sums, and the
// newest one's price and time.
interface Since {
  readonly high: number
  readonly low: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
  readonly last: number | undefined
  readonly time: DateTime.Utc | undefined
}

const NOTHING: Since = {
  high: -Infinity,
  low: Infinity,
  volume: 0,
  value: 0,
  frequency: 0,
  last: undefined,
  time: undefined,
}

const minuteOf = (time: DateTime.Utc) =>
  Math.floor(DateTime.toEpochMillis(time) / MINUTE) * MINUTE

// The index in `trades`, ascending by trade number, where `number` sits or
// would be inserted.
const positionOf = (trades: ReadonlyArray<Kept>, number: TradeNumber) => {
  let low = 0
  let high = trades.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (TradeNumberOrder(trades[middle]!.number, number) < 0) low = middle + 1
    else high = middle
  }
  return low
}

const after = (a: DateTime.Utc, b: DateTime.Utc | undefined) =>
  b === undefined || DateTime.isGreaterThan(a, b)

const latest = (...times: ReadonlyArray<DateTime.Utc | undefined>) =>
  times.reduce<DateTime.Utc | undefined>(
    (newest, time) =>
      time === undefined || !after(time, newest) ? newest : time,
    undefined
  )

const changeOf = (last: number, previousClose: number) => {
  const change = last - previousClose
  return {
    change,
    changePercent: previousClose === 0 ? 0 : (change / previousClose) * 100,
  }
}

// A frame with the totals only keeps the base's last price and the day's
// range, which a frame without them doesn't move.
const baseOf = (price: LivePrice, held: Base | undefined): Base => {
  const last = price.last ?? held?.last ?? 0
  const previousClose = price.previous ?? held?.previousClose ?? last
  return {
    last,
    previousClose,
    change: price.change,
    changePercent: price.changePercent,
    open: price.open ?? held?.open ?? last,
    high: price.high ?? held?.high ?? last,
    low: price.low ?? held?.low ?? last,
    volume: price.volume / 100,
    value: price.value,
    frequency: price.frequency,
    time: price.time,
  }
}

const fromStockbit = (code: StockCode, base: Base): DayState => ({
  code,
  last: base.last,
  previousClose: base.previousClose,
  // Stockbit leaves a zero change out of the frame.
  ...(base.change === undefined
    ? changeOf(base.last, base.previousClose)
    : { change: base.change, changePercent: base.changePercent ?? 0 }),
  open: base.open,
  high: base.high,
  low: base.low,
  volume: base.volume,
  value: base.value,
  frequency: base.frequency,
  asOf: base.time,
  provenance: "Stockbit",
})

// `tail`, the base minute's trades after the base, then `later`, the candles
// of the minutes after it folded into one, whose close is the newest trade.
const sinceOf = (
  tail: ReadonlyArray<Kept>,
  later: CandleFigures | undefined
): Since => {
  let since = NOTHING
  for (const trade of tail)
    since = {
      high: Math.max(since.high, trade.price),
      low: Math.min(since.low, trade.price),
      volume: since.volume + trade.lots,
      value: since.value + trade.price * trade.lots * 100,
      frequency: since.frequency + 1,
      last: trade.price,
      time: trade.time,
    }
  if (later === undefined) return since
  return {
    high: Math.max(since.high, later.high),
    low: Math.min(since.low, later.low),
    volume: since.volume + later.volume,
    value: since.value + later.value,
    frequency: since.frequency + later.frequency,
    last: later.close,
    time: DateTime.makeUnsafe(later.closeTime),
  }
}

// `start`'s figures carried on by the trades `since` it and an Ajaib `PRICE`
// newer than it.
const carriedOn = (
  code: StockCode,
  start: Base,
  since: Since,
  price: AjaibPrice | undefined
): DayState => {
  const last = price?.last ?? since.last ?? start.last
  return {
    code,
    last,
    previousClose: start.previousClose,
    ...(price === undefined
      ? changeOf(last, start.previousClose)
      : { change: price.change, changePercent: price.changePercent }),
    open: start.open,
    high: Math.max(start.high, since.high),
    low: Math.min(start.low, since.low),
    volume: start.volume + since.volume,
    value: start.value + since.value,
    frequency: start.frequency + since.frequency,
    asOf: latest(start.time, since.time, price?.time) ?? start.time,
    provenance: "Ajaib",
  }
}

// An Ajaib `PRICE` as the base of a code Stockbit never sent: it has no value
// or frequency, and its time is before every trade counted since.
const priceBase = (price: AjaibPrice): Base => ({
  last: price.last,
  previousClose: price.previousClose,
  change: price.change,
  changePercent: price.changePercent,
  open: price.open,
  high: price.high,
  low: price.low,
  volume: price.volume / 100,
  value: 0,
  frequency: 0,
  time: price.time,
})

// Decision: with Stockbit lost, last, high, low, volume, value and frequency
// carry on from the merged tape's regular-board trades after the last
// `liveprice`, the previous close stays as Stockbit last sent it, and an
// Ajaib `PRICE` newer than that frame fills the last price and the change
// (spec apinrdw/kumora#138, "Day state"). A code Stockbit never sent today
// starts from its `PRICE` frame, whose volume already holds the trades, and
// its value and frequency count the day's regular-board trades.
const fromFallback = (
  code: StockCode,
  base: Base | undefined,
  since: Since,
  ajaib: AjaibPrice | undefined
): DayState | undefined => {
  const price =
    ajaib !== undefined && after(ajaib.time, base?.time) ? ajaib : undefined
  if (base !== undefined) return carriedOn(code, base, since, price)
  if (price === undefined) return undefined
  return carriedOn(code, priceBase(price), { ...since, volume: 0 }, price)
}

// Decision: the trades after a code's base are read as the candle book's
// candles for the minutes after the base's, plus the base minute's trades
// after the base's time, kept here trade by trade. The candles are the day's
// regular-board trades as the store holds them, so a restart, a later copy
// of a trade (within the candle book's merge window) and a frame that
// arrives after trades newer than it all leave the same figures. A code also
// keeps its newest minute whole, so a frame in that minute cuts it exactly.
// A frame whose minute is neither (delayed past the minute's end) counts
// that minute's trades after it only from the next frame on.
export const makeDayStates = (candles: {
  readonly foldAfter: (
    code: StockCode,
    minute: number
  ) => Effect.Effect<CandleFigures | undefined>
}) =>
  Effect.sync(() => {
    const bases = new Map<StockCode, Base>()
    const kept = new Map<StockCode, ReadonlyArray<KeptMinute>>()
    const ajaibs = new Map<StockCode, AjaibPrice>()
    // Codes whose Stockbit figures changed, and whose fallback figures did.
    const stockbitChanged = new Set<StockCode>()
    const fallbackChanged = new Set<StockCode>()
    // Whether the last changes taken were Stockbit's: a switch resends all.
    let wasLive = true

    const baseMinuteOf = (code: StockCode) => {
      const base = bases.get(code)
      return base === undefined ? undefined : minuteOf(base.time)
    }

    // A frame older than the code's base, from the other connection or late,
    // changes nothing. The trades at or before the frame are in its totals:
    // the minutes before the frame's go, and its own minute keeps the trades
    // after it.
    const livePrice = (price: LivePrice) =>
      Effect.sync(() => {
        if (!price.regularBoard) return
        const held = bases.get(price.code)
        if (held !== undefined && !after(price.time, held.time)) return
        bases.set(price.code, baseOf(price, held))
        const minute = minuteOf(price.time)
        kept.set(
          price.code,
          (kept.get(price.code) ?? []).flatMap((candidate) => {
            if (candidate.minute < minute) return []
            if (candidate.minute > minute) return [candidate]
            const trades = candidate.trades.filter((trade) =>
              after(trade.time, price.time)
            )
            return trades.length === 0 ? [] : [{ minute, trades }]
          })
        )
        stockbitChanged.add(price.code)
        fallbackChanged.add(price.code)
      })

    const ajaibPrice = (price: AjaibPrice) =>
      Effect.sync(() => {
        const held = ajaibs.get(price.code)
        if (held !== undefined && !after(price.time, held.time)) return
        ajaibs.set(price.code, price)
        fallbackChanged.add(price.code)
      })

    // Whether a trade is in its code's figures since the base: on the
    // regular board, and after the base's time.
    const counts = (trade: RunningTrade) => {
      if (trade.board !== "RG") return false
      const base = bases.get(trade.code)
      return base === undefined || after(trade.time, base.time)
    }

    // Keeps a counted trade whole when its minute is its code's base minute
    // or at or past its newest; an older minute's trade is in its candle.
    const keep = (trade: RunningTrade) => {
      const minute = minuteOf(trade.time)
      const minutes = kept.get(trade.code) ?? []
      let held = minutes.find((candidate) => candidate.minute === minute)
      if (held === undefined) {
        const baseMinute = baseMinuteOf(trade.code)
        if (
          minute !== baseMinute &&
          minutes.some((candidate) => candidate.minute > minute)
        )
          return
        held = { minute, trades: [] }
        kept.set(trade.code, [
          ...minutes.filter(
            (candidate) =>
              candidate.minute === baseMinute || candidate.minute > minute
          ),
          held,
        ])
      }
      held.trades.splice(positionOf(held.trades, trade.tradeNumber), 0, {
        number: trade.tradeNumber,
        price: trade.price,
        lots: trade.lots,
        time: trade.time,
      })
    }

    const unkeep = (trade: RunningTrade) => {
      const minute = minuteOf(trade.time)
      const held = kept
        .get(trade.code)
        ?.find((candidate) => candidate.minute === minute)
      if (held === undefined) return
      const at = positionOf(held.trades, trade.tradeNumber)
      if (held.trades[at]?.number === trade.tradeNumber)
        held.trades.splice(at, 1)
    }

    // A trade as the merged tape now holds it: new (`held` undefined), or
    // merged from what it held before, which may change its price, lots,
    // board or time.
    const trade = (held: RunningTrade | undefined, current: RunningTrade) =>
      Effect.sync(() => {
        const removed = held !== undefined && counts(held)
        if (removed) unkeep(held)
        const added = counts(current)
        if (added) keep(current)
        if (removed || added) fallbackChanged.add(current.code)
      })

    // A code's Day state, from Stockbit while `stockbitLive`; undefined while
    // it has no figures yet.
    const stateOf = Effect.fnUntraced(function* (
      code: StockCode,
      stockbitLive: boolean
    ) {
      const base = bases.get(code)
      if (stockbitLive)
        return base === undefined ? undefined : fromStockbit(code, base)
      const baseMinute = baseMinuteOf(code)
      const tail =
        kept.get(code)?.find((held) => held.minute === baseMinute)?.trades ?? []
      const later = yield* candles.foldAfter(code, baseMinute ?? -Infinity)
      return fromFallback(code, base, sinceOf(tail, later), ajaibs.get(code))
    })

    const changedCodes = (stockbitLive: boolean) =>
      stockbitLive !== wasLive
        ? new Set([...bases.keys(), ...ajaibs.keys()])
        : stockbitLive
          ? stockbitChanged
          : fallbackChanged

    // The Day states of `watched` codes that changed since the last call.
    const takeChanged = Effect.fnUntraced(function* (
      stockbitLive: boolean,
      watched: ReadonlySet<StockCode>
    ) {
      const changed: Array<DayState> = []
      for (const code of changedCodes(stockbitLive)) {
        if (!watched.has(code)) continue
        const state = yield* stateOf(code, stockbitLive)
        if (state !== undefined) changed.push(state)
      }
      stockbitChanged.clear()
      fallbackChanged.clear()
      wasLive = stockbitLive
      return changed
    })

    const hasChanges = Effect.sync(
      () => stockbitChanged.size > 0 || fallbackChanged.size > 0
    )

    return { livePrice, ajaibPrice, trade, stateOf, takeChanged, hasChanges }
  })
