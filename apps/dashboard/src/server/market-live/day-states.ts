// Every code's Day state (spec apinrdw/kumora#138, "Day state" and "Starting
// values"): the last Stockbit `liveprice` frame per code, which carries the
// day's totals so far, and, while Stockbit's feed is lost, those figures
// carried on by the merged tape's regular-board trades and Ajaib's `PRICE`.
import type { DayState, RunningTrade, StockCode } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { AjaibPrice } from "./ajaib-price.ts"
import type { LivePrice } from "./stockbit-liveprice.ts"

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

// One counted trade, as much of it as the figures need.
interface Counted {
  readonly number: bigint
  readonly price: number
  readonly time: DateTime.Utc
}

// The regular-board trades of a code after its base's time: how many at
// each price, for the day's range; the newest few, ascending by trade
// number, for the last price and its time; and their sums. Decision: a
// feed's later copy of a trade can take it off the figures or move its
// price, so the range and the last price are kept in forms a removal
// leaves exact. The newest trades are capped at NEWEST_KEPT: a code's
// whole day of trades is more than the object holds.
interface Since {
  readonly prices: Map<number, number>
  readonly newest: Array<Counted>
  volume: number
  value: number
  frequency: number
}

const NEWEST_KEPT = 16

const rangeOf = (since: Since) => {
  let high = -Infinity
  let low = Infinity
  for (const price of since.prices.keys()) {
    high = Math.max(high, price)
    low = Math.min(low, price)
  }
  return { high, low }
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

// No trades counted since a base.
const NO_TRADES = {
  high: -Infinity,
  low: Infinity,
  volume: 0,
  value: 0,
  frequency: 0,
}

// `start`'s figures carried on by the trades `since` it and an Ajaib `PRICE`
// newer than it.
const carriedOn = (
  code: StockCode,
  start: Base,
  since: Since | undefined,
  price: AjaibPrice | undefined
): DayState => {
  const added =
    since === undefined ? NO_TRADES : { ...since, ...rangeOf(since) }
  const newest = since?.newest.at(-1)
  const last = price?.last ?? newest?.price ?? start.last
  return {
    code,
    last,
    previousClose: start.previousClose,
    ...(price === undefined
      ? changeOf(last, start.previousClose)
      : { change: price.change, changePercent: price.changePercent }),
    open: start.open,
    high: Math.max(start.high, added.high),
    low: Math.min(start.low, added.low),
    volume: start.volume + added.volume,
    value: start.value + added.value,
    frequency: start.frequency + added.frequency,
    asOf: latest(start.time, newest?.time, price?.time) ?? start.time,
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
// its value and frequency count only the regular-board trades this object
// saw.
const fromFallback = (
  code: StockCode,
  base: Base | undefined,
  since: Since | undefined,
  ajaib: AjaibPrice | undefined
): DayState | undefined => {
  const price =
    ajaib !== undefined && after(ajaib.time, base?.time) ? ajaib : undefined
  if (base !== undefined) return carriedOn(code, base, since, price)
  if (price === undefined) return undefined
  const counted = since === undefined ? undefined : { ...since, volume: 0 }
  return carriedOn(code, priceBase(price), counted, price)
}

export const makeDayStates = Effect.sync(() => {
  const bases = new Map<StockCode, Base>()
  const sinces = new Map<StockCode, Since>()
  const ajaibs = new Map<StockCode, AjaibPrice>()
  // Codes whose Stockbit figures changed, and whose fallback figures did.
  const stockbitChanged = new Set<StockCode>()
  const fallbackChanged = new Set<StockCode>()
  // Whether the last changes taken were Stockbit's: a switch resends all.
  let wasLive = true

  // A frame older than the code's base, from the other connection or late,
  // changes nothing. The trades counted since the old base are in the new.
  const livePrice = (price: LivePrice) =>
    Effect.sync(() => {
      if (!price.regularBoard) return
      const held = bases.get(price.code)
      if (held !== undefined && !after(price.time, held.time)) return
      bases.set(price.code, baseOf(price, held))
      sinces.delete(price.code)
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

  // Whether a trade belongs in its code's figures since the base: on the
  // regular board, and after the base's time.
  const counts = (trade: RunningTrade) => {
    if (trade.board !== "RG") return false
    const base = bases.get(trade.code)
    return base === undefined || after(trade.time, base.time)
  }

  const add = (trade: RunningTrade) => {
    const since = sinces.get(trade.code) ?? {
      prices: new Map(),
      newest: [],
      volume: 0,
      value: 0,
      frequency: 0,
    }
    const number = BigInt(trade.tradeNumber)
    const at = since.newest.findIndex((kept) => kept.number > number)
    since.newest.splice(at === -1 ? since.newest.length : at, 0, {
      number,
      price: trade.price,
      time: trade.time,
    })
    if (since.newest.length > NEWEST_KEPT) since.newest.shift()
    since.prices.set(trade.price, (since.prices.get(trade.price) ?? 0) + 1)
    since.volume += trade.lots
    since.value += trade.price * trade.lots * 100
    since.frequency += 1
    sinces.set(trade.code, since)
  }

  // Takes a counted trade back out. One the figures don't hold, because a
  // liveprice frame since took the base past it, is left alone.
  const remove = (trade: RunningTrade) => {
    const since = sinces.get(trade.code)
    const count = since?.prices.get(trade.price)
    if (since === undefined || count === undefined) return false
    if (count === 1) since.prices.delete(trade.price)
    else since.prices.set(trade.price, count - 1)
    const number = BigInt(trade.tradeNumber)
    const at = since.newest.findIndex((kept) => kept.number === number)
    if (at !== -1) since.newest.splice(at, 1)
    since.volume -= trade.lots
    since.value -= trade.price * trade.lots * 100
    since.frequency -= 1
    if (since.frequency === 0) sinces.delete(trade.code)
    return true
  }

  // A trade as the merged tape now holds it: new (`held` undefined), or
  // merged from what it held before, which may change its price, lots,
  // board or time.
  const trade = (held: RunningTrade | undefined, current: RunningTrade) =>
    Effect.sync(() => {
      const removed = held !== undefined && counts(held) && remove(held)
      const added = counts(current)
      if (added) add(current)
      if (removed || added) fallbackChanged.add(current.code)
    })

  // A code's Day state, from Stockbit while `stockbitLive`; undefined while
  // it has no figures yet.
  const stateOf = (code: StockCode, stockbitLive: boolean) =>
    Effect.sync(() => {
      const base = bases.get(code)
      if (stockbitLive)
        return base === undefined ? undefined : fromStockbit(code, base)
      return fromFallback(code, base, sinces.get(code), ajaibs.get(code))
    })

  const changedCodes = (stockbitLive: boolean) =>
    stockbitLive !== wasLive
      ? new Set([...bases.keys(), ...sinces.keys(), ...ajaibs.keys()])
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
