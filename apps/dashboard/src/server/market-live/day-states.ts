// Every code's Day state (spec apinrdw/kumora#138, "Day state" and "Starting
// values"): the last Stockbit `liveprice` frame per code, which carries the
// day's totals so far, and, while Stockbit's feed is lost, those figures
// carried on by the merged tape's regular-board trades and Ajaib's `PRICE`.
import {
  type DayChange,
  type DayState,
  type RunningTrade,
  type StockCode,
  type TradeNumber,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { tradePosition } from "../../lib/trade-position.ts"
import type { AjaibPrice } from "./ajaib-price.ts"
import { minuteOf, type CandleFigures } from "./candles.ts"
import { newerThanHeld } from "./late-frames.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

// A code's figures as of its last `liveprice` frame, the fallback's base. The
// previous close is as a frame last carried it; the change as the last frame
// with a last price did (Stockbit leaves a zero change out).
interface Base {
  readonly last: number
  readonly previousClose: number | undefined
  readonly change: DayChange | undefined
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
  readonly tradeNumber: TradeNumber
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

const latest = Effect.fnUntraced(function* (
  ...times: ReadonlyArray<DateTime.Utc | undefined>
) {
  let newest: DateTime.Utc | undefined
  for (const time of times)
    if (time !== undefined && (yield* newerThanHeld(time, newest)))
      newest = time
  return newest
})

// The change of `last` from `previousClose`, when the latter is known.
export const changeOf = (last: number, previousClose: number | undefined) =>
  Effect.sync((): DayChange | undefined => {
    if (previousClose === undefined) return undefined
    const amount = last - previousClose
    return {
      amount,
      percent: previousClose === 0 ? 0 : (amount / previousClose) * 100,
    }
  })

// A frame's change, as it carries it; Stockbit leaves its percent out with
// a zero change.
const frameChange = (price: LivePrice) =>
  Effect.succeed<DayChange | undefined>(
    price.change === undefined
      ? undefined
      : { amount: price.change, percent: price.changePercent ?? 0 }
  )

// A frame with the totals only keeps the base's last price and the day's
// range, which a frame without them doesn't move.
const baseOf = Effect.fnUntraced(function* (
  price: LivePrice,
  held: Base | undefined
) {
  const last = price.last ?? held?.last ?? 0
  const base: Base = {
    last,
    previousClose: price.previous ?? held?.previousClose,
    change: yield* frameChange(price),
    open: price.open ?? held?.open ?? last,
    high: price.high ?? held?.high ?? last,
    low: price.low ?? held?.low ?? last,
    volume: price.volume / 100,
    value: price.value,
    frequency: price.frequency,
    time: price.time,
  }
  return base
})

// The Day state's optional figures, each present when known.
const known = (
  previousClose: number | undefined,
  change: DayChange | undefined
) =>
  Effect.succeed({
    ...(previousClose === undefined ? {} : { previousClose }),
    ...(change === undefined ? {} : { change }),
  })

const fromStockbit = Effect.fnUntraced(function* (code: StockCode, base: Base) {
  const state: DayState = {
    code,
    last: base.last,
    ...(yield* known(
      base.previousClose,
      base.change ?? (yield* changeOf(base.last, base.previousClose))
    )),
    open: base.open,
    high: base.high,
    low: base.low,
    volume: base.volume,
    value: base.value,
    frequency: base.frequency,
    asOf: base.time,
    provenance: "Stockbit",
  }
  return state
})

// `tail`, the base minute's trades after the base, then `later`, the candles
// of the minutes after it folded into one, whose close is the newest trade.
const sinceOf = (tail: ReadonlyArray<Kept>, later: CandleFigures | undefined) =>
  Effect.sync((): Since => {
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
  })

// `start`'s figures carried on by the trades `since` it and an Ajaib `PRICE`
// newer than it.
const carriedOn = Effect.fnUntraced(function* (
  code: StockCode,
  start: Base,
  since: Since,
  price: AjaibPrice | undefined
) {
  const last = price?.last ?? since.last ?? start.last
  const previousClose = start.previousClose ?? price?.previousClose
  const state: DayState = {
    code,
    last,
    ...(yield* known(
      previousClose,
      price === undefined
        ? yield* changeOf(last, previousClose)
        : { amount: price.change, percent: price.changePercent }
    )),
    open: start.open,
    high: Math.max(start.high, since.high),
    low: Math.min(start.low, since.low),
    volume: start.volume + since.volume,
    value: start.value + since.value,
    frequency: start.frequency + since.frequency,
    asOf: (yield* latest(start.time, since.time, price?.time)) ?? start.time,
    provenance: "Ajaib",
  }
  return state
})

// An Ajaib `PRICE` as the base of a code Stockbit never sent: it has no value
// or frequency, and its time is before every trade counted since.
const priceBase = (price: AjaibPrice) =>
  Effect.succeed<Base>({
    last: price.last,
    previousClose: price.previousClose,
    change: { amount: price.change, percent: price.changePercent },
    open: price.open,
    high: price.high,
    low: price.low,
    volume: price.volume / 100,
    value: 0,
    frequency: 0,
    time: price.time,
  })

// Decision: with Stockbit lost, a code carries on from its last `liveprice`
// plus the regular-board trades after it, or, never sent, from its `PRICE`
// frame (volume included) plus the day's regular-board value and frequency.
// An Ajaib `PRICE` newer than the `liveprice` fills last and change; the
// previous close stays as sent. See spec apinrdw/kumora#138.
const fromFallback = Effect.fnUntraced(function* (
  code: StockCode,
  base: Base | undefined,
  since: Since,
  ajaib: AjaibPrice | undefined
) {
  const price =
    ajaib !== undefined && (yield* newerThanHeld(ajaib.time, base?.time))
      ? ajaib
      : undefined
  if (base !== undefined) return yield* carriedOn(code, base, since, price)
  if (price === undefined) return undefined
  return yield* carriedOn(
    code,
    yield* priceBase(price),
    { ...since, volume: 0 },
    price
  )
})

// Decision: the trades after a code's base are read as the candle book's
// candles after the base minute plus that minute's trades kept here, so a
// restart, a late copy of a trade and an out-of-order frame leave the same
// figures. A frame delayed past its minute's end counts that minute's trades
// only from the next frame on. See apinrdw/kumora#157.
//
// The guards here read what a code holds and then write it, across yields:
// the trading day runs its callers one at a time (its `turn` permit).
export const makeDayStates = (candles: {
  readonly foldAfter: (
    code: StockCode,
    minute: number | undefined
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

    const baseMinuteOf = Effect.fnUntraced(function* (code: StockCode) {
      const base = bases.get(code)
      return base === undefined ? undefined : yield* minuteOf(base.time)
    })

    // A frame older than the code's base, from the other connection or late,
    // changes nothing. The trades at or before the frame are in its totals:
    // the minutes before the frame's go, and its own minute keeps the trades
    // after it.
    // The code's kept minutes from the frame's on, its own minute keeping
    // only the trades after the frame.
    const keptAfter = Effect.fnUntraced(function* (price: LivePrice) {
      const minute = yield* minuteOf(price.time)
      const minutes: Array<KeptMinute> = []
      for (const candidate of kept.get(price.code) ?? []) {
        if (candidate.minute > minute) minutes.push(candidate)
        if (candidate.minute !== minute) continue
        const trades: Array<Kept> = []
        for (const trade of candidate.trades)
          if (yield* newerThanHeld(trade.time, price.time)) trades.push(trade)
        if (trades.length > 0) minutes.push({ minute, trades })
      }
      return minutes
    })

    const livePrice = Effect.fnUntraced(function* (price: LivePrice) {
      if (!price.regularBoard) return
      const held = bases.get(price.code)
      if (held !== undefined && !(yield* newerThanHeld(price.time, held.time)))
        return
      bases.set(price.code, yield* baseOf(price, held))
      kept.set(price.code, yield* keptAfter(price))
      stockbitChanged.add(price.code)
      fallbackChanged.add(price.code)
    })

    const ajaibPrice = Effect.fnUntraced(function* (price: AjaibPrice) {
      const held = ajaibs.get(price.code)
      if (held !== undefined && !(yield* newerThanHeld(price.time, held.time)))
        return
      ajaibs.set(price.code, price)
      fallbackChanged.add(price.code)
    })

    // Whether a trade is in its code's figures since the base: on the
    // regular board, and after the base's time.
    const counts = Effect.fnUntraced(function* (trade: RunningTrade) {
      if (trade.board !== "RG") return false
      const base = bases.get(trade.code)
      return base === undefined || (yield* newerThanHeld(trade.time, base.time))
    })

    // Keeps a counted trade whole when its minute is its code's base minute
    // or at or past its newest; an older minute's trade is in its candle.
    const keep = Effect.fnUntraced(function* (trade: RunningTrade) {
      const minute = yield* minuteOf(trade.time)
      const minutes = kept.get(trade.code) ?? []
      let held = minutes.find((candidate) => candidate.minute === minute)
      if (held === undefined) {
        const baseMinute = yield* baseMinuteOf(trade.code)
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
      held.trades.splice(
        yield* tradePosition(held.trades, trade.tradeNumber),
        0,
        {
          tradeNumber: trade.tradeNumber,
          price: trade.price,
          lots: trade.lots,
          time: trade.time,
        }
      )
    })

    const unkeep = Effect.fnUntraced(function* (trade: RunningTrade) {
      const minute = yield* minuteOf(trade.time)
      const held = kept
        .get(trade.code)
        ?.find((candidate) => candidate.minute === minute)
      if (held === undefined) return
      const at = yield* tradePosition(held.trades, trade.tradeNumber)
      if (held.trades[at]?.tradeNumber === trade.tradeNumber)
        held.trades.splice(at, 1)
    })

    // A trade as the merged tape now holds it: new (`held` undefined), or
    // merged from what it held before, which may change its price, lots,
    // board or time.
    const trade = Effect.fnUntraced(function* (
      held: RunningTrade | undefined,
      current: RunningTrade
    ) {
      const removed = held !== undefined && (yield* counts(held))
      if (removed) yield* unkeep(held)
      const added = yield* counts(current)
      if (added) yield* keep(current)
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
        return base === undefined ? undefined : yield* fromStockbit(code, base)
      const baseMinute = yield* baseMinuteOf(code)
      const tail =
        kept.get(code)?.find((held) => held.minute === baseMinute)?.trades ?? []
      const later = yield* candles.foldAfter(code, baseMinute)
      return yield* fromFallback(
        code,
        base,
        yield* sinceOf(tail, later),
        ajaibs.get(code)
      )
    })

    const changedCodes = (stockbitLive: boolean) =>
      Effect.sync(() =>
        stockbitLive !== wasLive
          ? new Set([...bases.keys(), ...ajaibs.keys()])
          : stockbitLive
            ? stockbitChanged
            : fallbackChanged
      )

    // The Day states of `watched` codes that changed since the last call.
    const takeChanged = Effect.fnUntraced(function* (
      stockbitLive: boolean,
      watched: ReadonlySet<StockCode>
    ) {
      const changed: Array<DayState> = []
      for (const code of yield* changedCodes(stockbitLive)) {
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
