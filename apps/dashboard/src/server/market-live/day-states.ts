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

// The regular-board trades of a code after its base's time, summed.
interface Since {
  readonly lastNumber: bigint
  readonly last: number
  readonly high: number
  readonly low: number
  readonly volume: number
  readonly value: number
  readonly frequency: number
  readonly time: DateTime.Utc
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
  const previousClose = price.previousClose ?? held?.previousClose ?? last
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
  const added = since ?? NO_TRADES
  const last = price?.last ?? since?.last ?? start.last
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
    asOf: latest(start.time, since?.time, price?.time) ?? start.time,
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

  // A new trade on the merged tape, each trade number once.
  const trade = (arriving: RunningTrade) =>
    Effect.sync(() => {
      if (arriving.board !== "RG") return
      const base = bases.get(arriving.code)
      if (base !== undefined && !after(arriving.time, base.time)) return
      const held = sinces.get(arriving.code)
      const number = BigInt(arriving.tradeNumber)
      const newest = held === undefined || number > held.lastNumber
      sinces.set(arriving.code, {
        lastNumber: newest ? number : held.lastNumber,
        last: newest ? arriving.price : held.last,
        high: Math.max(arriving.price, held?.high ?? -Infinity),
        low: Math.min(arriving.price, held?.low ?? Infinity),
        volume: (held?.volume ?? 0) + arriving.lots,
        value: (held?.value ?? 0) + arriving.price * arriving.lots * 100,
        frequency: (held?.frequency ?? 0) + 1,
        time: latest(arriving.time, held?.time) ?? arriving.time,
      })
      fallbackChanged.add(arriving.code)
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
