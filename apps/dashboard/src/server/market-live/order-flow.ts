// Each code's order flow state (spec apinrdw/kumora#605, "Order flow events:
// the rules" and "data"): its minute figures from the trades the candle book
// settles, the day's high and low, sessions, relay gaps and the restart's
// replay. It folds each minute at its close and hands every continuous
// minute of every share to the rules (order-flow-rules.ts), once per side.
// A late trade folds its code again from the trade's minute.
import {
  FLUSH_PAST_MINUTE,
  INDEX_CODES,
  MINUTE_MS,
  EventOrder,
  SHARES_PER_LOT,
  kindOf,
  marketPhases,
  type OrderFlowEvent,
  type OrderFlowSide,
  type RelayGap,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { Array as Arr, DateTime, Effect } from "effect"

import type { CandleFigures } from "./candles.ts"
import type { Cells } from "./footprint-cells.ts"
import {
  PUSH_MINUTES,
  SIDE,
  SIDES,
  makeRules,
  type ContinuousPhase,
  type Extreme,
  type FoldedMinute,
  type MinuteFigures,
  type SideExtremes,
} from "./order-flow-rules.ts"

// Decision: a relay gap shorter than 10 s never blocks a check; one of 10 s
// or longer that overlaps a rule's window does, and so does one still open.
// The daily 13:31:05 gap is 3–4 s. See apinrdw/kumora#602.
const GAP_BLOCKS_MS = 10_000

// Decision: a trade up to 10 minutes behind the newest folded minute folds
// its code again from its minute, as if it had come in time; an older one
// stays out of the state (a restart's replay counts it). A gap's backfill
// (gaps.ts) takes about 100 s at its widest, and each code holds this many
// minutes and their states. See PR #633.
const LATE_MINUTES = 10

// What a code's minutes fold into, as it stands before a minute.
interface Folding {
  readonly extremes: Record<OrderFlowSide, Extreme | undefined>
  // The day's cumulative delta in lots through the minutes folded: the
  // footprint chart's CVD (lib/footprint.ts, minuteTotals).
  readonly cum: number
  // The last traded price.
  readonly last: number | undefined
  readonly window: ReadonlyArray<MinuteFigures>
  readonly windowSession: ContinuousPhase | undefined
  // Each rule's memory of the code, as an Effect that puts it back.
  readonly memory: ReadonlyArray<Effect.Effect<void>>
}

// A minute folded in the last LATE_MINUTES: its figures, which a late trade
// still moves, the state before it was folded, and the kind and side of
// each event it sent.
interface Held {
  readonly figures: MinuteFigures
  readonly before: Folding
  readonly sent: Set<string>
}

interface CodeFlow {
  // Minutes with trades not folded yet, by minute.
  readonly pending: Map<number, MinuteFigures>
  // The minutes folded in the last LATE_MINUTES, oldest first.
  held: Array<Held>
  // The oldest folded minute a late trade moved since the last judge.
  lateFrom: number | undefined
  window: Array<MinuteFigures>
  windowSession: ContinuousPhase | undefined
  readonly extremes: Record<OrderFlowSide, Extreme | undefined>
  cum: number
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

// A minute's figures before its first trade, at `price`. Plain: the
// Decision at `settled`.
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
  cells: new Map(),
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
  if (print.buyValue <= 0 && print.sellValue <= 0) return
  let cell = figures.cells.get(print.close)
  if (cell === undefined) {
    cell = { buy: 0, sell: 0 }
    figures.cells.set(print.close, cell)
  }
  if (print.buyValue > 0) {
    figures.buyLots += print.volume
    figures.buyValue += print.buyValue
    cell.buy += print.volume
  }
  if (print.sellValue > 0) {
    figures.sellLots += print.volume
    figures.sellValue += print.sellValue
    cell.sell += print.volume
  }
}

// One stored minute of one code, as a restart reads it back: its candle's
// figures and its footprint's cells (none for an index).
export interface StoredMinute {
  readonly minute: number
  readonly figures: Pick<CandleFigures, "high" | "low" | "close" | "closeOrder">
  readonly cells: Cells | undefined
}

// A stored minute as the prints `settled` adds: the range's ends and each
// cell's lots by side, then the close.
// Decision: a restart reads candles and footprints back, not the day's
// trades: a minute's figures are its range, close and lots by side and
// price, which these hold, at two rows a minute against a busy day's
// millions of trades.
const printsOf = (stored: StoredMinute) =>
  Effect.sync(() => {
    const at = (price: number, closeOrder = -1n) => ({
      close: price,
      closeOrder,
      volume: 0,
      buyValue: 0,
      sellValue: 0,
    })
    const prints: Array<Print> = [
      at(stored.figures.high),
      at(stored.figures.low),
    ]
    for (const [price, lots] of stored.cells ?? []) {
      const value = (count: number) => count * SHARES_PER_LOT * price
      if (lots.buy > 0)
        prints.push({
          ...at(price),
          volume: lots.buy,
          buyValue: value(lots.buy),
        })
      if (lots.sell > 0)
        prints.push({
          ...at(price),
          volume: lots.sell,
          sellValue: value(lots.sell),
        })
    }
    prints.push(at(stored.figures.close, stored.figures.closeOrder))
    return prints
  })

// Every code's order flow state for the trading day `date`. It resets only
// with the day: one trading-day object holds one day.
export const makeOrderFlow = Effect.fnUntraced(function* (date: WibDate) {
  const judging = yield* makeRules
  // Each session's continuous minutes, as the starts of its first minute
  // and of the minute after its last. Session 1's last second (12:00:00,
  // 11:30:00 on Friday) is no minute of its own.
  const sessions: Array<{
    readonly session: ContinuousPhase
    readonly from: number
    readonly to: number
  }> = []
  // A day past the baked schedule has none: nothing is judged on it.
  const phases = yield* marketPhases(date).pipe(
    Effect.catchTag("ScheduleYearMissing", () => Effect.succeed([]))
  )
  for (const phase of phases)
    if (phase.phase === "session-1" || phase.phase === "session-2") {
      const from = DateTime.toEpochMillis(phase.from)
      const end = DateTime.toEpochMillis(phase.to)
      sessions.push({
        session: phase.phase,
        from,
        to: Math.floor(end / MINUTE_MS) * MINUTE_MS,
      })
    }
  const sessionOf = (minute: number) =>
    Effect.sync(() =>
      sessions.find(({ from, to }) => minute >= from && minute < to)
    )

  const codes = new Map<StockCode, CodeFlow>()
  // The newest minute folded, for every code.
  let foldedThrough = Number.NEGATIVE_INFINITY

  // Decision: `settled`, `addPrint` and `emptyAt` stay plain: the candle
  // book calls `settled` for each trade it settles, in its own plain
  // arithmetic, as it does the bubble book's. Measured 2026-11-22 on the dev
  // machine: 100,000 settles over 900 codes took 13 ms plain, 62 ms as
  // Effects. See PR #633.
  //
  // A trade in a minute already folded moves that minute's figures and marks
  // the code to fold again from it at the next judge.
  const settled = (code: StockCode, minute: number, print: Print) => {
    let flow = codes.get(code)
    if (flow === undefined) {
      flow = {
        pending: new Map(),
        held: [],
        lateFrom: undefined,
        window: [],
        windowSession: undefined,
        extremes: { buy: undefined, sell: undefined },
        cum: 0,
        last: undefined,
        share: undefined,
      }
      codes.set(code, flow)
    }
    let figures: MinuteFigures | undefined
    if (minute <= foldedThrough) {
      if (minute <= foldedThrough - LATE_MINUTES * MINUTE_MS) return
      figures = flow.held.find(
        (each) => each.figures.minute === minute
      )?.figures
      flow.lateFrom = Math.min(flow.lateFrom ?? minute, minute)
    }
    figures ??= flow.pending.get(minute)
    if (figures === undefined) {
      figures = emptyAt(minute, print.close)
      flow.pending.set(minute, figures)
    }
    addPrint(figures, print)
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
    const sides = {} as Record<OrderFlowSide, SideExtremes>
    for (const side of SIDES) {
      const before = flow.extremes[side]
      const price = yield* SIDE[side].extremeOf(figures)
      const set =
        figures.traded &&
        (before === undefined ||
          (yield* SIDE[side].beyond(price, before.price)))
      if (set)
        flow.extremes[side] = {
          price,
          at: figures.minute,
          delta: flow.cum,
          pullback: undefined,
        }
      else if (before !== undefined) {
        const back = yield* SIDE[side].backOf(figures)
        if (
          before.pullback === undefined ||
          (yield* SIDE[side].beyond(before.pullback, back))
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
    session: ContinuousPhase | undefined
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

  // Every rule's events on one folded minute, for each side.
  const judgeFolded = Effect.fnUntraced(function* (folded: FoldedMinute) {
    const found: Array<OrderFlowEvent> = []
    for (const rule of judging)
      for (const side of SIDES) {
        const event = yield* rule.judge(folded, side)
        if (event !== undefined) found.push(event)
      }
    return found
  })

  // The code's state as it stands, to fold again from.
  const saved = Effect.fnUntraced(function* (code: StockCode, flow: CodeFlow) {
    const copy = (extreme: Extreme | undefined) =>
      extreme === undefined ? undefined : { ...extreme }
    return {
      extremes: {
        buy: copy(flow.extremes.buy),
        sell: copy(flow.extremes.sell),
      },
      cum: flow.cum,
      last: flow.last,
      window: [...flow.window],
      windowSession: flow.windowSession,
      memory: yield* Effect.forEach(judging, (rule) => rule.save(code)),
    } satisfies Folding
  })

  const restoreTo = Effect.fnUntraced(function* (
    flow: CodeFlow,
    folding: Folding
  ) {
    flow.extremes.buy = folding.extremes.buy
    flow.extremes.sell = folding.extremes.sell
    flow.cum = folding.cum
    flow.last = folding.last
    flow.window = [...folding.window]
    flow.windowSession = folding.windowSession
    for (const put of folding.memory) yield* put
  })

  // Folds one minute of one code into its state, holds it for late trades
  // and judges it. `sent` is what an earlier fold of the minute sent, which
  // is not sent again.
  const fold = Effect.fnUntraced(function* (
    code: StockCode,
    flow: CodeFlow,
    minute: number,
    blocked: FoldedMinute["blocked"],
    sent: ReadonlySet<string> = new Set()
  ) {
    const traded = flow.pending.get(minute)
    flow.pending.delete(minute)
    if (traded === undefined && flow.last === undefined) return []
    const figures = traded ?? emptyAt(minute, flow.last!)
    const held: Held = {
      figures,
      before: yield* saved(code, flow),
      sent: new Set(sent),
    }
    flow.held.push(held)
    flow.cum += figures.buyLots - figures.sellLots
    const session = yield* sessionOf(minute)
    const sides = yield* moveExtremes(flow, figures)
    yield* slide(flow, figures, session?.session)
    flow.share ??= yield* isShare(code)
    if (session === undefined || !flow.share) return []
    const folded: FoldedMinute = {
      code,
      figures,
      session: session.session,
      sessionStart: session.from,
      window: [...flow.window],
      sides,
      blocked,
    }
    const found: Array<OrderFlowEvent> = []
    for (const event of yield* judgeFolded(folded)) {
      const key = `${event.kind}|${event.side}`
      if (held.sent.has(key)) continue
      held.sent.add(key)
      found.push(event)
    }
    return found
  })

  // Folds one code's minutes up to `through` in time order: its traded ones
  // and every continuous one in `continuous`. Holds the last LATE_MINUTES.
  const foldCode = Effect.fnUntraced(function* (
    code: StockCode,
    flow: CodeFlow,
    continuous: ReadonlyArray<number>,
    through: number,
    blocked: FoldedMinute["blocked"],
    sent: ReadonlyMap<number, ReadonlySet<string>> = new Map()
  ) {
    const minutes = new Set(continuous)
    for (const minute of flow.pending.keys())
      if (minute <= through) minutes.add(minute)
    const found: Array<OrderFlowEvent> = []
    for (const minute of [...minutes].sort((a, b) => a - b))
      found.push(
        ...(yield* fold(code, flow, minute, blocked, sent.get(minute)))
      )
    const kept = flow.held.findIndex(
      (each) => each.figures.minute > through - LATE_MINUTES * MINUTE_MS
    )
    flow.held = kept < 0 ? [] : flow.held.slice(kept)
    return found
  })

  // Folds a code again from the oldest minute a late trade moved, from the
  // state before it, then on to `through`: its state ends as if the late
  // trades had arrived in time.
  const foldLate = Effect.fnUntraced(function* (
    code: StockCode,
    flow: CodeFlow,
    from: number,
    through: number,
    blocked: FoldedMinute["blocked"]
  ) {
    const at = flow.held.findIndex((each) => each.figures.minute >= from)
    const again = at < 0 ? [] : flow.held.splice(at)
    if (again[0] !== undefined) yield* restoreTo(flow, again[0].before)
    for (const { figures } of again)
      if (figures.traded) flow.pending.set(figures.minute, figures)
    return yield* foldCode(
      code,
      flow,
      yield* continuousBetween(from - MINUTE_MS, through),
      through,
      blocked,
      new Map(again.map((each) => [each.figures.minute, each.sent]))
    )
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
  // in time order, under the relay gaps so far, and folds again from each
  // late trade's minute. Returns the events found, oldest first.
  const judge = Effect.fnUntraced(function* (
    now: number,
    gaps: ReadonlyArray<RelayGap>
  ) {
    const through = Math.max(yield* dueAt(now), foldedThrough)
    const blocked = blockedBy(gaps)
    const continuous = yield* continuousBetween(foldedThrough, through)
    const found: Array<OrderFlowEvent> = []
    for (const [code, flow] of codes) {
      const late = flow.lateFrom
      flow.lateFrom = undefined
      if (late !== undefined)
        found.push(...(yield* foldLate(code, flow, late, through, blocked)))
      else if (through > foldedThrough)
        found.push(
          ...(yield* foldCode(code, flow, continuous, through, blocked))
        )
    }
    foldedThrough = through
    return Arr.sort(found, EventOrder)
  })

  // Rebuilds the state after a restart from each code's stored minutes, one
  // code at a time, judging every minute due at `now` as `judge` did, under
  // the day's relay gaps with any still open ended at `now`. Hands `found`
  // each code's events the rules found again, oldest first. Run before any
  // trade.
  // Decision: the restart replays the day through the rules rather than
  // storing their state: the day's high and low, cumulative delta, windows
  // and each rule's memory come back as the minutes made them, whatever a
  // rule keeps. A gap the restart opened ends at `now`, so it blocks no
  // minute before it. See apinrdw/kumora#612.
  const restore = Effect.fnUntraced(function* <E>(
    stored: ReadonlyArray<StockCode>,
    minutesOf: (
      code: StockCode
    ) => Effect.Effect<ReadonlyArray<StoredMinute>, E>,
    now: number,
    gaps: ReadonlyArray<RelayGap>,
    found: (events: ReadonlyArray<OrderFlowEvent>) => Effect.Effect<void, E>
  ) {
    const through = yield* dueAt(now)
    const continuous = yield* continuousBetween(
      Number.NEGATIVE_INFINITY,
      through
    )
    const blocked = blockedBy(
      gaps.map((gap) => ({ ...gap, to: gap.to ?? DateTime.makeUnsafe(now) }))
    )
    for (const code of stored) {
      for (const minute of yield* minutesOf(code))
        for (const print of yield* printsOf(minute))
          settled(code, minute.minute, print)
      const flow = codes.get(code)
      if (flow === undefined) continue
      const events = yield* foldCode(code, flow, continuous, through, blocked)
      if (events.length > 0) yield* found(Arr.sort(events, EventOrder))
    }
    foldedThrough = Math.max(foldedThrough, through)
  })

  return { settled, due, judge, restore }
})
