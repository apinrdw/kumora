// The order flow rules (spec apinrdw/kumora#605, "Order flow events: the
// rules"): Exhaustion, Delta divergence and Failed break, each judging one
// folded minute of one share for one side (order-flow.ts folds them). The
// rules read minutes as the threshold replay did
// (docs/research/order-flow-event-thresholds.md on branch
// research/order-flow-event-thresholds, replay.mjs.txt).
//
// A rule keeps whatever it needs between minutes in its own per-code memory,
// and joins `makeRules`.
import {
  MINUTE_MS,
  SHARES_PER_LOT,
  ticksBetween,
  type MarketPhase,
  type OrderFlowEvent,
  type OrderFlowSide,
  type StockCode,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { LEVEL_FLOOR } from "./level-ledger.ts"

// Decision: the push is the 5 minutes before the latest: at 3 or 8 minutes
// busy-code rates move by 10% or less. See apinrdw/kumora#595 and
// apinrdw/kumora#599.
export const PUSH_MINUTES = 5

// Decision: the latest minute's extreme is within 2 ticks of the day's: at 1
// tick the open's events fall 16%, at 3 they rise 9%. See
// apinrdw/kumora#595 and apinrdw/kumora#599.
const NEAR_TICKS = 2

// Decision: the latest minute's side lots are at most ½ the push's busiest
// minute's: ⅓ to ⅔ pick almost the same events. See apinrdw/kumora#595 and
// apinrdw/kumora#599.
const DRIED_UP = 0.5

// Decision: the latest minute's range is at most ½ the push's widest
// minute's: at ⅓ busy events fall by two thirds, at ⅔ nothing changes. See
// apinrdw/kumora#595 and apinrdw/kumora#599.
const SLOWED = 0.5

// Decision: the push's widest minute spans at least 3 ticks, dropping the
// "2 ticks, then 1" events that only said the next minute was quieter. See
// apinrdw/kumora#602.
const WIDEST_TICKS = 3

// Decision: the push's busiest minute had at least Rp100 M of the side's
// aggressor value, the book events' floor: at Rp250 M mid codes lose a
// third. See apinrdw/kumora#595 and apinrdw/kumora#599.
const PUSH_FLOOR = LEVEL_FLOOR

// Decision: no push minute falls in Session 1's first 5 minutes
// (09:00–09:04), whose highs and lows almost every code sets at once;
// Session 2 has no such skip. See apinrdw/kumora#602.
const OPEN_SKIP_MINUTES = 5

// Decision: Delta divergence's earlier high is at least 10 minutes before
// the new one, so a push that sets several highs in a row doesn't fire. See
// apinrdw/kumora#596 and apinrdw/kumora#599.
const EARLIER_MINUTES = 10

// Decision: price traded at least 3 ticks back from the earlier high
// between the two, so they are separate highs and not one push. See
// apinrdw/kumora#596 and apinrdw/kumora#599.
const PULLBACK_TICKS = 3

// Decision: cumulative delta trails the earlier high's by at least Rp100 M
// of lots at the new high's price, the book events' floor: strictly lower or
// a % margin fires on noise and breaks near zero. See apinrdw/kumora#596 and
// apinrdw/kumora#599.
const DIVERGENCE_FLOOR = LEVEL_FLOOR

// Decision: a Failed break's level is the day's extreme as it stood, set at
// least 10 minutes before the break (candle start times), so a push's own
// new extremes are never levels. See apinrdw/kumora#597.
const LEVEL_AGE_MINUTES = 10

// Decision: a break trades at least 1 tick past the level. See
// apinrdw/kumora#597.
const BREAK_TICKS = 1

// Decision: from the breaking minute through the return, the side's
// aggressor value at prices strictly past the level totals at least
// Rp100 M, the book events' floor. See apinrdw/kumora#597 and
// apinrdw/kumora#599.
const BREAK_FLOOR = LEVEL_FLOOR

// Decision: a minute closes back inside within 3 minutes counting the
// breaking minute, so a one-minute wick counts. See apinrdw/kumora#597.
const RETURN_MINUTES = 3

// One price's buy-aggressor and sell-aggressor lots in a minute.
interface CellLots {
  buy: number
  sell: number
}

// The continuous trading a judged minute falls in: Session 1 or Session 2.
export type ContinuousPhase = Extract<MarketPhase, "session-1" | "session-2">

// What the rules read of one minute of one code: its range and close, and
// each aggressor side's lots and value (lots × 100 × price, as the
// footprint's cells sum it). A minute with no trades has 0 lots, and the
// last price as its high, low and close.
export interface MinuteFigures {
  readonly minute: number
  high: number
  low: number
  close: number
  closeOrder: bigint
  buyLots: number
  sellLots: number
  buyValue: number
  sellValue: number
  traded: boolean
  // Each price's lots by aggressor side, as the footprint's cells.
  readonly cells: Map<number, CellLots>
}

// The price a side's day extreme stands at, the minute that set it and
// the cumulative delta at that minute's close (an auction minute's lots have
// no side, so they add 0). `pullback` is the furthest price back from it,
// on the other side, of the minutes since: undefined until one follows.
export interface Extreme {
  readonly price: number
  readonly at: number
  readonly delta: number
  pullback: number | undefined
}

// One side's day extreme before a minute and after it; `set` when the
// minute traded beyond the one before.
export interface SideExtremes {
  readonly before: Extreme | undefined
  readonly extreme: Extreme | undefined
  readonly set: boolean
}

// One folded minute of a share's continuous trading, as a rule reads it.
// Auction and other minutes only move the day's extremes and are never
// judged.
export interface FoldedMinute {
  readonly code: StockCode
  readonly figures: MinuteFigures
  readonly session: ContinuousPhase
  // The session's start, in epoch ms.
  readonly sessionStart: number
  // The consecutive continuous minutes of the session up to and including
  // this one, at most PUSH_MINUTES + 1, oldest first.
  readonly window: ReadonlyArray<MinuteFigures>
  readonly sides: Readonly<Record<OrderFlowSide, SideExtremes>>
  // Whether a relay gap blocks a check over the minutes from `from` up to
  // the end of `to`'s minute, both minute starts.
  readonly blocked: (from: number, to: number) => Effect.Effect<boolean>
}

interface OrderFlowRule {
  readonly judge: (
    minute: FoldedMinute,
    side: OrderFlowSide
  ) => Effect.Effect<OrderFlowEvent | undefined>
  // The rule's memory of `code` as it stands, as an Effect that puts it
  // back: order-flow.ts folds a code again from a late trade's minute.
  readonly save: (code: StockCode) => Effect.Effect<Effect.Effect<void>>
}

export const SIDES: ReadonlyArray<OrderFlowSide> = ["buy", "sell"]

// How a side reads prices and minutes: the buy side the high and buy
// aggressors, the sell side the low and sell aggressors.
interface SideReading {
  // Whether price `a` lies past `b` toward the side's extreme.
  readonly beyond: (a: number, b: number) => Effect.Effect<boolean>
  // The minute's price furthest toward the side's extreme.
  readonly extremeOf: (figures: MinuteFigures) => Effect.Effect<number>
  // The minute's price furthest back from it: the low for the high.
  readonly backOf: (figures: MinuteFigures) => Effect.Effect<number>
  // The side's aggressor lots and value in a minute, and lots at a price.
  readonly lotsOf: (figures: MinuteFigures) => Effect.Effect<number>
  readonly valueOf: (figures: MinuteFigures) => Effect.Effect<number>
  readonly cellLots: (cell: CellLots) => Effect.Effect<number>
  // The ticks from `price` back to `extreme`, on the side's own direction.
  readonly ticksShort: (price: number, extreme: number) => Effect.Effect<number>
  // 1 when the side's cumulative delta trails by being lower (the high), −1
  // by being higher (the low).
  readonly trails: number
}

export const SIDE: Readonly<Record<OrderFlowSide, SideReading>> = {
  buy: {
    beyond: (a, b) => Effect.succeed(a > b),
    extremeOf: (figures) => Effect.succeed(figures.high),
    backOf: (figures) => Effect.succeed(figures.low),
    lotsOf: (figures) => Effect.succeed(figures.buyLots),
    valueOf: (figures) => Effect.succeed(figures.buyValue),
    cellLots: (cell) => Effect.succeed(cell.buy),
    ticksShort: (price, extreme) => ticksBetween(price, extreme),
    trails: 1,
  },
  sell: {
    beyond: (a, b) => Effect.succeed(a < b),
    extremeOf: (figures) => Effect.succeed(figures.low),
    backOf: (figures) => Effect.succeed(figures.high),
    lotsOf: (figures) => Effect.succeed(figures.sellLots),
    valueOf: (figures) => Effect.succeed(figures.sellValue),
    cellLots: (cell) => Effect.succeed(cell.sell),
    ticksShort: (price, extreme) => ticksBetween(extreme, price),
    trails: -1,
  },
}

const rangeOf = (figures: MinuteFigures) =>
  ticksBetween(figures.low, figures.high)

// A rule's per-code memory key for one side.
const sideKey = (code: StockCode, side: OrderFlowSide) =>
  Effect.succeed(`${code}|${side}`)

// Saves one code's entries, both sides, of a rule's per-code memory.
const saveSides = Effect.fnUntraced(function* <A>(
  memory: Map<string, A>,
  code: StockCode
) {
  const saved: Array<readonly [string, A | undefined]> = []
  for (const side of SIDES) {
    const key = yield* sideKey(code, side)
    saved.push([key, memory.get(key)])
  }
  return Effect.sync(() => {
    for (const [key, value] of saved)
      if (value === undefined) memory.delete(key)
      else memory.set(key, value)
  })
})

// The push's busiest minute for the side, by aggressor lots, and its widest
// range in ticks.
const pushFigures = Effect.fnUntraced(function* (
  side: OrderFlowSide,
  push: ReadonlyArray<MinuteFigures>
) {
  let busiest = push[0]!
  let widest = 0
  for (const each of push) {
    if ((yield* SIDE[side].lotsOf(each)) > (yield* SIDE[side].lotsOf(busiest)))
      busiest = each
    widest = Math.max(widest, yield* rangeOf(each))
  }
  return { busiest, widest }
})

// Whether Session 1's open skip (OPEN_SKIP_MINUTES) holds a push starting
// at `from` back.
const inOpen = (minute: FoldedMinute, from: number) =>
  Effect.succeed(
    minute.session === "session-1" &&
      from < minute.sessionStart + OPEN_SKIP_MINUTES * MINUTE_MS
  )

// Exhaustion (spec apinrdw/kumora#605, "Order flow events: the rules"): a
// push of 5 minutes that set the day's extreme, then a latest minute whose
// side's aggressors dried up and whose range shrank, near the extreme
// without passing it. Once per extreme.
const makeExhaustion = Effect.sync((): OrderFlowRule => {
  // Each code's side's extreme it last fired at.
  const fired = new Map<string, number>()

  // The push and the extreme it set, when the latest minute can be judged:
  // a full window, a push that set the extreme and a latest minute that
  // didn't, past the open's skip, and not fired at this extreme yet.
  const armed = Effect.fnUntraced(function* (
    minute: FoldedMinute,
    side: OrderFlowSide
  ) {
    const { extreme, set } = minute.sides[side]
    if (set || extreme === undefined) return undefined
    if (minute.window.length < PUSH_MINUTES + 1) return undefined
    const push = minute.window.slice(0, PUSH_MINUTES)
    const from = push[0]!.minute
    if (extreme.at < from || extreme.at >= minute.figures.minute)
      return undefined
    if (yield* inOpen(minute, from)) return undefined
    const firedAt = fired.get(yield* sideKey(minute.code, side))
    if (
      firedAt !== undefined &&
      !(yield* SIDE[side].beyond(extreme.price, firedAt))
    )
      return undefined
    return { push, from, extreme }
  })

  return {
    judge: Effect.fnUntraced(function* (minute, side) {
      const check = yield* armed(minute, side)
      if (check === undefined) return undefined
      const { figures } = minute
      const { busiest, widest } = yield* pushFigures(side, check.push)
      const peakLots = yield* SIDE[side].lotsOf(busiest)
      const lots = yield* SIDE[side].lotsOf(figures)
      const ticks = yield* rangeOf(figures)
      const near = yield* SIDE[side].ticksShort(
        yield* SIDE[side].extremeOf(figures),
        check.extreme.price
      )
      const passes =
        peakLots > 0 &&
        near <= NEAR_TICKS &&
        lots <= DRIED_UP * peakLots &&
        ticks <= SLOWED * widest &&
        widest >= WIDEST_TICKS &&
        (yield* SIDE[side].valueOf(busiest)) >= PUSH_FLOOR
      if (!passes || (yield* minute.blocked(check.from, figures.minute)))
        return undefined
      fired.set(yield* sideKey(minute.code, side), check.extreme.price)
      return {
        kind: "exhaustion",
        code: minute.code,
        at: DateTime.makeUnsafe(figures.minute),
        side,
        price: check.extreme.price,
        lots,
        peakLots,
        ticks,
        widestTicks: widest,
      } satisfies OrderFlowEvent
    }),
    save: (code) => saveSides(fired, code),
  }
})

// Delta divergence (spec apinrdw/kumora#605, "Order flow events: the
// rules"): a minute that set a new day's extreme while cumulative delta
// trailed the earlier extreme's by Rp100 M, with price pulled back between
// the two. Each new extreme is judged once, as the minute that set it.
const makeDivergence = Effect.sync((): OrderFlowRule => ({
  judge: Effect.fnUntraced(function* (minute, side) {
    const { before, extreme, set } = minute.sides[side]
    if (!set || before === undefined || extreme === undefined) return undefined
    const { figures } = minute
    if (figures.minute - before.at < EARLIER_MINUTES * MINUTE_MS)
      return undefined
    if (
      before.pullback === undefined ||
      (yield* SIDE[side].ticksShort(before.pullback, before.price)) <
        PULLBACK_TICKS
    )
      return undefined
    const { trails } = SIDE[side]
    const floorLots = DIVERGENCE_FLOOR / (SHARES_PER_LOT * extreme.price)
    if ((before.delta - extreme.delta) * trails < floorLots) return undefined
    if (yield* minute.blocked(before.at, figures.minute)) return undefined
    return {
      kind: "divergence",
      code: minute.code,
      at: DateTime.makeUnsafe(figures.minute),
      side,
      price: extreme.price,
      delta: extreme.delta,
      earlierAt: DateTime.makeUnsafe(before.at),
      earlierPrice: before.price,
      earlierDelta: before.delta,
    } satisfies OrderFlowEvent
  }),
  save: () => Effect.succeed(Effect.void),
}))

// The side's aggressor value at prices strictly past `level` in one minute.
const valuePast = Effect.fnUntraced(function* (
  side: OrderFlowSide,
  figures: MinuteFigures,
  level: number
) {
  let value = 0
  for (const [price, cell] of figures.cells)
    if (yield* SIDE[side].beyond(price, level))
      value += (yield* SIDE[side].cellLots(cell)) * SHARES_PER_LOT * price
  return value
})

// A break under way: the level it went past and its breaking minute.
interface Break {
  readonly level: number
  readonly from: number
}

// Failed break (spec apinrdw/kumora#605, "Order flow events: the rules"):
// trades past a day's extreme set at least 10 minutes before, with real
// aggressor value past it, then a minute closing back inside within 3
// minutes of the same session. A break that stays out ends there: its own
// extreme is the day's, and becomes a level 10 minutes on.
const makeFailedBreak = Effect.sync((): OrderFlowRule => {
  // Each code's side's break under way.
  const open = new Map<string, Break>()

  // The break this minute starts, if it sets the day's extreme past a level
  // old enough.
  const started = Effect.fnUntraced(function* (
    minute: FoldedMinute,
    side: OrderFlowSide
  ) {
    const { before, set } = minute.sides[side]
    const { figures } = minute
    if (!set || before === undefined) return undefined
    if (figures.minute - before.at < LEVEL_AGE_MINUTES * MINUTE_MS)
      return undefined
    const past = yield* SIDE[side].ticksShort(
      before.price,
      yield* SIDE[side].extremeOf(figures)
    )
    if (past < BREAK_TICKS) return undefined
    return { level: before.price, from: figures.minute } satisfies Break
  })

  // The side's aggressor value past the level and the farthest price traded,
  // over the window's minutes from the break on.
  const reached = Effect.fnUntraced(function* (
    minute: FoldedMinute,
    side: OrderFlowSide,
    going: Break
  ) {
    let value = 0
    let far = going.level
    for (const each of minute.window) {
      if (each.minute < going.from) continue
      value += yield* valuePast(side, each, going.level)
      const reach = yield* SIDE[side].extremeOf(each)
      if (yield* SIDE[side].beyond(reach, far)) far = reach
    }
    return { value, far }
  })

  return {
    judge: Effect.fnUntraced(function* (minute, side) {
      const key = yield* sideKey(minute.code, side)
      const { figures } = minute
      const held = open.get(key)
      open.delete(key)
      // Rules only judge continuous minutes, and no session ends within
      // RETURN_MINUTES of the next one's start: a break still within them
      // is in its own session.
      const going =
        held !== undefined &&
        figures.minute < held.from + RETURN_MINUTES * MINUTE_MS
          ? held
          : yield* started(minute, side)
      if (going === undefined) return undefined
      if (!(yield* SIDE[side].beyond(going.level, figures.close))) {
        open.set(key, going)
        return undefined
      }
      const { value, far } = yield* reached(minute, side, going)
      if (
        value < BREAK_FLOOR ||
        (yield* minute.blocked(going.from, figures.minute))
      )
        return undefined
      return {
        kind: "failedBreak",
        code: minute.code,
        at: DateTime.makeUnsafe(figures.minute),
        side,
        price: going.level,
        to: far,
        value,
        close: figures.close,
        minutes: (figures.minute - going.from) / MINUTE_MS,
      } satisfies OrderFlowEvent
    }),
    save: (code) => saveSides(open, code),
  }
})

// Every rule, each with fresh per-code memory, in the order they judge a
// minute.
export const makeRules = Effect.gen(function* () {
  const rules: ReadonlyArray<OrderFlowRule> = [
    yield* makeExhaustion,
    yield* makeDivergence,
    yield* makeFailedBreak,
  ]
  return rules
})
