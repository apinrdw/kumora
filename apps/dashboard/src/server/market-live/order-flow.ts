// Each code's order flow state (spec apinrdw/kumora#605, "Order flow events:
// the rules" and "data"): its minute figures from the trades the candle book
// settles, the day's high and low, and the order flow rules judged at each
// minute's close. The rules read minutes as the threshold replay did
// (docs/research/order-flow-event-thresholds.md on branch
// research/order-flow-event-thresholds, replay.mjs.txt).
//
// A rule judges every folded minute of every share, once per side, and keeps
// whatever it needs between minutes in its own per-code memory. Failed break
// joins `judging` in makeOrderFlow beside Exhaustion and Delta divergence.
import {
  FLUSH_PAST_MINUTE,
  INDEX_CODES,
  MINUTE_MS,
  OrderFlowEventOrder,
  SHARES_PER_LOT,
  kindOf,
  marketPhases,
  ticksBetween,
  type OrderFlowEvent,
  type OrderFlowSide,
  type RelayGap,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { Array as Arr, DateTime, Effect } from "effect"

import type { CandleFigures } from "./candles.ts"

// Decision: a relay gap shorter than 10 s never blocks a check; one of 10 s
// or longer that overlaps a rule's window does, and so does one still open.
// The daily 13:31:05 gap is 3–4 s. See apinrdw/kumora#602.
const GAP_BLOCKS_MS = 10_000

// Decision: the push is the 5 minutes before the latest: at 3 or 8 minutes
// busy-code rates move by 10% or less. See apinrdw/kumora#595 and
// apinrdw/kumora#599.
const PUSH_MINUTES = 5

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
const PUSH_FLOOR = 100_000_000

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
// of lots at the new high's price: strictly lower or a % margin fires on
// noise and breaks near zero. See apinrdw/kumora#596 and apinrdw/kumora#599.
const DIVERGENCE_FLOOR = 100_000_000

// What the rules read of one minute of one code: its range and close, and
// each aggressor side's lots and value (lots × 100 × price, as the
// footprint's cells sum it). A minute with no trades has 0 lots, and the
// last price as its high, low and close.
interface MinuteFigures {
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
}

// The price a side's day extreme stands at, the minute that set it and
// the cumulative delta at that minute's close (an auction minute's lots have
// no side, so they add 0). `pullback` is the furthest price back from it,
// on the other side, of the minutes since: undefined until one follows.
interface Extreme {
  readonly price: number
  readonly at: number
  readonly delta: number
  pullback: number | undefined
}

// One folded minute as a rule reads it.
interface FoldedMinute {
  readonly code: StockCode
  readonly figures: MinuteFigures
  // Which session's continuous trading the minute is in: 0 or 1, undefined
  // for an auction or any other minute, which only moves the day's extremes.
  readonly session: number | undefined
  // The session's start, in epoch ms, when `session` is defined.
  readonly sessionStart: number | undefined
  // The consecutive continuous minutes of the session up to and including
  // this one, at most PUSH_MINUTES + 1, oldest first.
  readonly window: ReadonlyArray<MinuteFigures>
  // Each side's day extreme before this minute and after it; `set` when
  // this minute traded beyond the one before.
  readonly sides: Readonly<
    Record<
      OrderFlowSide,
      {
        readonly before: Extreme | undefined
        readonly extreme: Extreme | undefined
        readonly set: boolean
      }
    >
  >
  // Whether a relay gap blocks a check over the minutes from `from` up to
  // the end of `to`'s minute, both minute starts.
  readonly blocked: (from: number, to: number) => Effect.Effect<boolean>
}

interface OrderFlowRule {
  readonly judge: (
    minute: FoldedMinute,
    side: OrderFlowSide
  ) => Effect.Effect<OrderFlowEvent | undefined>
}

const SIDES: ReadonlyArray<OrderFlowSide> = ["buy", "sell"]

// A side's figures: the buy side reads the high, the sell side the low.
const beyond = (side: OrderFlowSide, a: number, b: number) =>
  Effect.succeed(side === "buy" ? a > b : a < b)
const extremeOf = (side: OrderFlowSide, figures: MinuteFigures) =>
  Effect.succeed(side === "buy" ? figures.high : figures.low)
// The price furthest back from the side's extreme: the low for the high.
const backOf = (side: OrderFlowSide, figures: MinuteFigures) =>
  Effect.succeed(side === "buy" ? figures.low : figures.high)
const lotsOf = (side: OrderFlowSide, figures: MinuteFigures) =>
  Effect.succeed(side === "buy" ? figures.buyLots : figures.sellLots)
const valueOf = (side: OrderFlowSide, figures: MinuteFigures) =>
  Effect.succeed(side === "buy" ? figures.buyValue : figures.sellValue)
const rangeOf = (figures: MinuteFigures) =>
  ticksBetween(figures.low, figures.high)
// The ticks from `price` back to the extreme, on the side's own direction.
const ticksShort = (side: OrderFlowSide, price: number, extreme: number) =>
  side === "buy" ? ticksBetween(price, extreme) : ticksBetween(extreme, price)

// The push's busiest minute for the side, by aggressor lots, and its widest
// range in ticks.
const pushFigures = Effect.fnUntraced(function* (
  side: OrderFlowSide,
  push: ReadonlyArray<MinuteFigures>
) {
  let busiest = push[0]!
  let widest = 0
  for (const each of push) {
    if ((yield* lotsOf(side, each)) > (yield* lotsOf(side, busiest)))
      busiest = each
    widest = Math.max(widest, yield* rangeOf(each))
  }
  return { busiest, widest }
})

// Whether Session 1's open skip (OPEN_SKIP_MINUTES) holds a push starting
// at `from` back.
const inOpen = (minute: FoldedMinute, from: number) =>
  Effect.succeed(
    minute.session === 0 &&
      from < minute.sessionStart! + OPEN_SKIP_MINUTES * MINUTE_MS
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
    const firedAt = fired.get(`${minute.code}|${side}`)
    if (firedAt !== undefined && !(yield* beyond(side, extreme.price, firedAt)))
      return undefined
    return { push, from, extreme }
  })

  return {
    judge: Effect.fnUntraced(function* (minute, side) {
      const check = yield* armed(minute, side)
      if (check === undefined) return undefined
      const { figures } = minute
      const { busiest, widest } = yield* pushFigures(side, check.push)
      const peakLots = yield* lotsOf(side, busiest)
      const lots = yield* lotsOf(side, figures)
      const ticks = yield* rangeOf(figures)
      const near = yield* ticksShort(
        side,
        yield* extremeOf(side, figures),
        check.extreme.price
      )
      const passes =
        peakLots > 0 &&
        near <= NEAR_TICKS &&
        lots <= DRIED_UP * peakLots &&
        ticks <= SLOWED * widest &&
        widest >= WIDEST_TICKS &&
        (yield* valueOf(side, busiest)) >= PUSH_FLOOR
      if (!passes || (yield* minute.blocked(check.from, figures.minute)))
        return undefined
      fired.set(`${minute.code}|${side}`, check.extreme.price)
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
      (yield* ticksShort(side, before.pullback, before.price)) < PULLBACK_TICKS
    )
      return undefined
    const trails = side === "buy" ? 1 : -1
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
}))

interface CodeFlow {
  // Minutes with trades not folded yet, by minute.
  readonly pending: Map<number, MinuteFigures>
  window: Array<MinuteFigures>
  windowSession: number | undefined
  readonly extremes: Record<OrderFlowSide, Extreme | undefined>
  // The day's cumulative delta in lots, through the newest folded minute and
  // any late trade since: the footprint chart's CVD (lib/footprint.ts,
  // minuteTotals).
  cum: number
  // The last traded price, as of the newest folded minute.
  last: number | undefined
  // Whether the rules judge the code: shares only, decided on its first fold.
  share: boolean | undefined
}

// The fields of a trade's print (candles.ts) the state reads: its price,
// order, lots and value by aggressor side.
type Print = Pick<
  CandleFigures,
  "close" | "closeOrder" | "volume" | "buyValue" | "sellValue"
>

const emptyAt = (minute: number, price: number): MinuteFigures => ({
  minute,
  high: price,
  low: price,
  close: price,
  closeOrder: -1n,
  buyLots: 0,
  sellLots: 0,
  buyValue: 0,
  sellValue: 0,
  traded: false,
})

// Adds one trade to a minute's figures. Plain: the Decision at `settled`.
const addPrint = (figures: MinuteFigures, print: Print) => {
  if (!figures.traded) {
    figures.high = print.close
    figures.low = print.close
    figures.traded = true
  }
  figures.high = Math.max(figures.high, print.close)
  figures.low = Math.min(figures.low, print.close)
  if (print.closeOrder > figures.closeOrder) {
    figures.close = print.close
    figures.closeOrder = print.closeOrder
  }
  if (print.buyValue > 0) {
    figures.buyLots += print.volume
    figures.buyValue += print.buyValue
  }
  if (print.sellValue > 0) {
    figures.sellLots += print.volume
    figures.sellValue += print.sellValue
  }
}

// Every code's order flow state for the trading day `date`. It resets only
// with the day: one trading-day object holds one day.
export const makeOrderFlow = Effect.fnUntraced(function* (date: WibDate) {
  // Failed break joins here.
  const judging: ReadonlyArray<OrderFlowRule> = [
    yield* makeExhaustion,
    yield* makeDivergence,
  ]
  // Each session's continuous minutes, as the starts of its first minute
  // and of the minute after its last. Session 1's last second (12:00:00,
  // 11:30:00 on Friday) is no minute of its own.
  const sessions: Array<{ readonly from: number; readonly to: number }> = []
  // A day past the baked schedule has none: nothing is judged on it.
  const phases = yield* marketPhases(date).pipe(
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed([]))
  )
  for (const phase of phases)
    if (phase.phase === "session-1" || phase.phase === "session-2") {
      const from = DateTime.toEpochMillis(phase.from)
      const end = DateTime.toEpochMillis(phase.to)
      sessions.push({ from, to: Math.floor(end / MINUTE_MS) * MINUTE_MS })
    }
  const sessionOf = (minute: number) =>
    Effect.sync(() => {
      const index = sessions.findIndex(
        ({ from, to }) => minute >= from && minute < to
      )
      return index < 0 ? undefined : index
    })

  const codes = new Map<StockCode, CodeFlow>()
  // The newest minute folded, for every code.
  let foldedThrough = Number.NEGATIVE_INFINITY

  // Decision: `settled` and its `addPrint` stay plain, as the bubble book's
  // do (bubble-book.ts, the Decision at sumsOf): the candle book calls it for
  // each regular-board trade it settles, inside its own plain arithmetic.
  //
  // A trade in a minute already folded moves that minute's figures, if the
  // window still holds it, the cumulative delta and the day's extremes. An
  // extreme it sets takes the cumulative delta as it stands, since the
  // minute after it is rarely folded yet.
  const settled = (code: StockCode, minute: number, print: Print) => {
    let flow = codes.get(code)
    if (flow === undefined) {
      flow = {
        pending: new Map(),
        window: [],
        windowSession: undefined,
        extremes: { buy: undefined, sell: undefined },
        cum: 0,
        last: undefined,
        share: undefined,
      }
      codes.set(code, flow)
    }
    if (minute > foldedThrough) {
      let figures = flow.pending.get(minute)
      if (figures === undefined) {
        figures = emptyAt(minute, print.close)
        flow.pending.set(minute, figures)
      }
      addPrint(figures, print)
      return
    }
    const held = flow.window.find((each) => each.minute === minute)
    if (held !== undefined) addPrint(held, print)
    if (print.buyValue > 0) flow.cum += print.volume
    if (print.sellValue > 0) flow.cum -= print.volume
    const { buy, sell } = flow.extremes
    const set = { price: print.close, at: minute, delta: flow.cum }
    if (buy === undefined || print.close > buy.price)
      flow.extremes.buy = { ...set, pullback: undefined }
    else if (minute > buy.at)
      buy.pullback = Math.min(buy.pullback ?? print.close, print.close)
    if (sell === undefined || print.close < sell.price)
      flow.extremes.sell = { ...set, pullback: undefined }
    else if (minute > sell.at)
      sell.pullback = Math.max(sell.pullback ?? print.close, print.close)
  }

  // The latest minute judged at `now`: the newest whose close was
  // FLUSH_PAST_MINUTE ago, so its candle has settled.
  const dueAt = (now: number) =>
    Effect.succeed(
      Math.floor((now - FLUSH_PAST_MINUTE) / MINUTE_MS) * MINUTE_MS - MINUTE_MS
    )

  // Whether `judge` at `now` would fold a minute.
  const due = (now: number) =>
    Effect.map(dueAt(now), (minute) => minute > foldedThrough)

  const blockedBy = (gaps: ReadonlyArray<RelayGap>) =>
    Effect.fnUntraced(function* (from: number, to: number) {
      for (const gap of gaps) {
        if (gap.to === undefined) return true
        const start = DateTime.toEpochMillis(gap.from)
        const end = DateTime.toEpochMillis(gap.to)
        if (
          end - start >= GAP_BLOCKS_MS &&
          start < to + MINUTE_MS &&
          end > from
        )
          return true
      }
      return false
    })

  const isShare = Effect.fnUntraced(function* (code: StockCode) {
    return !INDEX_CODES.includes(code) && (yield* kindOf(code)) === "share"
  })

  // Moves each side's day extreme by one minute's figures, or how far price
  // came back from it, and says what it stood at before. The cumulative
  // delta already counts the minute.
  const moveExtremes = Effect.fnUntraced(function* (
    flow: CodeFlow,
    figures: MinuteFigures
  ) {
    const sides = {} as Record<OrderFlowSide, FoldedMinute["sides"]["buy"]>
    for (const side of SIDES) {
      const before = flow.extremes[side]
      const price = yield* extremeOf(side, figures)
      const set =
        figures.traded &&
        (before === undefined || (yield* beyond(side, price, before.price)))
      if (set)
        flow.extremes[side] = {
          price,
          at: figures.minute,
          delta: flow.cum,
          pullback: undefined,
        }
      else if (before !== undefined) {
        const back = yield* backOf(side, figures)
        if (
          before.pullback === undefined ||
          (yield* beyond(side, before.pullback, back))
        )
          before.pullback = back
      }
      sides[side] = { before, extreme: flow.extremes[side], set }
    }
    if (figures.traded) flow.last = figures.close
    return sides
  })

  // Slides the code's window on to a continuous minute of `session`: it
  // starts again after a minute missing or another session's.
  const slide = (
    flow: CodeFlow,
    figures: MinuteFigures,
    session: number | undefined
  ) =>
    Effect.sync(() => {
      const previous = flow.window.at(-1)
      const follows =
        session !== undefined &&
        flow.windowSession === session &&
        previous?.minute === figures.minute - MINUTE_MS
      if (!follows) flow.window = []
      if (session !== undefined) flow.window.push(figures)
      if (flow.window.length > PUSH_MINUTES + 1) flow.window.shift()
      flow.windowSession = session
    })

  // Every rule's events on one folded minute, each side.
  const judgeFolded = Effect.fnUntraced(function* (folded: FoldedMinute) {
    const found: Array<OrderFlowEvent> = []
    for (const rule of judging)
      for (const side of SIDES) {
        const event = yield* rule.judge(folded, side)
        if (event !== undefined) found.push(event)
      }
    return found
  })

  // Folds one minute of one code into its state and judges it.
  const fold = Effect.fnUntraced(function* (
    code: StockCode,
    flow: CodeFlow,
    minute: number,
    blocked: FoldedMinute["blocked"]
  ) {
    const traded = flow.pending.get(minute)
    flow.pending.delete(minute)
    if (traded === undefined && flow.last === undefined) return []
    const figures = traded ?? emptyAt(minute, flow.last!)
    flow.cum += figures.buyLots - figures.sellLots
    const session = yield* sessionOf(minute)
    const sides = yield* moveExtremes(flow, figures)
    yield* slide(flow, figures, session)
    flow.share ??= yield* isShare(code)
    if (session === undefined || !flow.share) return []
    const folded: FoldedMinute = {
      code,
      figures,
      session,
      sessionStart: sessions[session]!.from,
      window: [...flow.window],
      sides,
      blocked,
    }
    return yield* judgeFolded(folded)
  })

  // The continuous minutes after `after` up to `through`.
  const continuousBetween = (after: number, through: number) =>
    Effect.sync(() => {
      const minutes: Array<number> = []
      for (const { from, to } of sessions)
        for (
          let minute = Math.max(from, after + MINUTE_MS);
          minute < to && minute <= through;
          minute += MINUTE_MS
        )
          minutes.push(minute)
      return minutes
    })

  // Folds and judges every minute up to the latest due at `now`, each code's
  // in time order, under the relay gaps so far. Returns the events found,
  // oldest first.
  const judge = Effect.fnUntraced(function* (
    now: number,
    gaps: ReadonlyArray<RelayGap>
  ) {
    const through = yield* dueAt(now)
    if (through <= foldedThrough) return []
    const continuous = yield* continuousBetween(foldedThrough, through)
    const blocked = blockedBy(gaps)
    const found: Array<OrderFlowEvent> = []
    for (const [code, flow] of codes) {
      const minutes = new Set(continuous)
      for (const minute of flow.pending.keys())
        if (minute <= through) minutes.add(minute)
      for (const minute of [...minutes].sort((a, b) => a - b))
        found.push(...(yield* fold(code, flow, minute, blocked)))
    }
    foldedThrough = through
    return Arr.sort(found, OrderFlowEventOrder)
  })

  return { settled, due, judge }
})
