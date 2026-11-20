// Each code's order flow state (spec apinrdw/kumora#605, "Order flow events:
// the rules" and "data"): its minute figures from the trades the candle book
// settles, the day's high and low, sessions, relay gaps and the restart's
// replay. It folds each minute at its close and hands every continuous
// minute of every share to the rules (order-flow-rules.ts), once per side.
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
  type Extreme,
  type FoldedMinute,
  type MinuteFigures,
  type SideExtremes,
} from "./order-flow-rules.ts"

// Decision: a relay gap shorter than 10 s never blocks a check; one of 10 s
// or longer that overlaps a rule's window does, and so does one still open.
// The daily 13:31:05 gap is 3–4 s. See apinrdw/kumora#602.
const GAP_BLOCKS_MS = 10_000

interface CodeFlow {
  // Minutes with trades not folded yet, by minute.
  readonly pending: Map<number, MinuteFigures>
  window: Array<MinuteFigures>
  windowSession: number | undefined
  readonly extremes: Record<OrderFlowSide, Extreme | undefined>
  // Each side's day extreme as it stood before a late trade moved it, until
  // `judge` judges the move (`judgeLate`).
  readonly moved: Record<OrderFlowSide, Extreme | undefined>
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
  // minute after it is rarely folded yet, and keeps the extreme it moved for
  // `judgeLate`.
  const settled = (code: StockCode, minute: number, print: Print) => {
    let flow = codes.get(code)
    if (flow === undefined) {
      flow = {
        pending: new Map(),
        window: [],
        windowSession: undefined,
        extremes: { buy: undefined, sell: undefined },
        moved: { buy: undefined, sell: undefined },
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
    if (buy === undefined || print.close > buy.price) {
      flow.moved.buy ??= buy
      flow.extremes.buy = { ...set, pullback: undefined }
    } else if (minute > buy.at)
      buy.pullback = Math.min(buy.pullback ?? print.close, print.close)
    if (sell === undefined || print.close < sell.price) {
      flow.moved.sell ??= sell
      flow.extremes.sell = { ...set, pullback: undefined }
    } else if (minute > sell.at)
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

  // Every rule's events on one folded minute, for each of `sides`.
  const judgeFolded = Effect.fnUntraced(function* (
    folded: FoldedMinute,
    sides: ReadonlyArray<OrderFlowSide> = SIDES
  ) {
    const found: Array<OrderFlowEvent> = []
    for (const rule of judging)
      for (const side of sides) {
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

  // Judges each side's extreme a late trade moved (`settled`) as its own
  // minute setting it, again, for that side only: as if the trade had
  // arrived before the minute was folded, which is how a restart replays
  // it. A move in a minute the window no longer holds, an auction minute's
  // or one over PUSH_MINUTES back, is not judged.
  // Decision: a late trade's new high or low is judged once, at the next
  // judge, as the minute it traded in, rather than left unjudged or credited
  // to a later minute: its event then matches the one a restart's replay
  // finds. Rules read a minute judged again from its window entry, so
  // Failed break counts its value once. See spec apinrdw/kumora#605, "Order
  // flow events: the rules" ("Each new high is judged once").
  const judgeLate = Effect.fnUntraced(function* (
    code: StockCode,
    flow: CodeFlow,
    blocked: FoldedMinute["blocked"]
  ) {
    const found: Array<OrderFlowEvent> = []
    for (const side of SIDES) {
      const before = flow.moved[side]
      const extreme = flow.extremes[side]
      flow.moved[side] = undefined
      if (before === undefined || extreme === undefined) continue
      const at = flow.window.findIndex((each) => each.minute === extreme.at)
      const session = flow.windowSession
      if (at < 0 || session === undefined || flow.share !== true) continue
      const still = (each: Extreme | undefined): SideExtremes => ({
        before: each,
        extreme: each,
        set: false,
      })
      const sides: Record<OrderFlowSide, SideExtremes> = {
        buy: still(flow.extremes.buy),
        sell: still(flow.extremes.sell),
        [side]: { before, extreme, set: true },
      }
      const folded: FoldedMinute = {
        code,
        figures: flow.window[at]!,
        session,
        sessionStart: sessions[session]!.from,
        window: flow.window.slice(0, at + 1),
        sides,
        blocked,
      }
      found.push(...(yield* judgeFolded(folded, [side])))
    }
    return found
  })

  // Folds one code's minutes after `after` up to `through`, in time order:
  // its traded ones and every continuous one.
  const foldCode = Effect.fnUntraced(function* (
    code: StockCode,
    flow: CodeFlow,
    continuous: ReadonlyArray<number>,
    through: number,
    blocked: FoldedMinute["blocked"]
  ) {
    const minutes = new Set(continuous)
    for (const minute of flow.pending.keys())
      if (minute <= through) minutes.add(minute)
    const found: Array<OrderFlowEvent> = []
    for (const minute of [...minutes].sort((a, b) => a - b))
      found.push(...(yield* fold(code, flow, minute, blocked)))
    return found
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
    const blocked = blockedBy(gaps)
    const found: Array<OrderFlowEvent> = []
    for (const [code, flow] of codes)
      found.push(...(yield* judgeLate(code, flow, blocked)))
    if (through > foldedThrough) {
      const continuous = yield* continuousBetween(foldedThrough, through)
      for (const [code, flow] of codes)
        found.push(
          ...(yield* foldCode(code, flow, continuous, through, blocked))
        )
      foldedThrough = through
    }
    return Arr.sort(found, EventOrder)
  })

  // Rebuilds the state after a restart from each code's stored minutes, one
  // code at a time, judging every minute due at `now` as `judge` did, under
  // the day's relay gaps with any still open ended at `now`. Returns the
  // events the rules found again, oldest first. Run before any trade.
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
    gaps: ReadonlyArray<RelayGap>
  ) {
    const through = yield* dueAt(now)
    const continuous = yield* continuousBetween(
      Number.NEGATIVE_INFINITY,
      through
    )
    const blocked = blockedBy(
      gaps.map((gap) => ({ ...gap, to: gap.to ?? DateTime.makeUnsafe(now) }))
    )
    const found: Array<OrderFlowEvent> = []
    for (const code of stored) {
      for (const minute of yield* minutesOf(code))
        for (const print of yield* printsOf(minute))
          settled(code, minute.minute, print)
      const flow = codes.get(code)
      if (flow !== undefined)
        found.push(
          ...(yield* foldCode(code, flow, continuous, through, blocked))
        )
    }
    foldedThrough = Math.max(foldedThrough, through)
    return Arr.sort(found, EventOrder)
  })

  return { settled, due, judge, restore }
})
