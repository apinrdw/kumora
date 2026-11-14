import {
  TradeNumberOrder,
  addToSweeps,
  joinSweeps,
  sweepsOf,
  type RecordedSweeps,
  type RunningTrade,
  type StockCode,
  type Sweep,
  type TradeNumber,
  type ViewerDown,
} from "@workspace/relay"
import { Effect } from "effect"

import {
  TOP_N_DEFAULT,
  sweepMinute,
  sweepThreshold,
  type SweepThreshold,
} from "@/lib/sweeps"

// What changed since the listener last heard: the sweeps, the top-N, or the
// selected sweep. A selection carries its minute, so whatever shows it can
// jump there: chart 1 scrolls to it, the sweep log scrolls to its row, and
// chart 2 can move to it (apinrdw/kumora#268).
export type SweepChange =
  | { readonly _tag: "Sweeps" }
  | { readonly _tag: "TopN" }
  | {
      readonly _tag: "Selected"
      readonly id: number
      readonly minute: number
      // Where it was picked: a bubble on chart 1, or a row of the log.
      readonly from: "chart" | "log"
    }

export interface SweepStore {
  readonly code: StockCode
  // The selected code's sweeps and auction matches so far, in trade order.
  // A sweep's index is its id while the code stays selected.
  readonly sweeps: () => ReadonlyArray<Sweep>
  readonly topN: () => number
  readonly setTopN: (percent: number) => void
  // The top-N threshold over the sweeps up to `at` (epoch ms; live, the end
  // of time), worked out once for the bubbles, the log and the control.
  readonly threshold: (at: number) => SweepThreshold
  readonly selected: () => number | undefined
  readonly select: (id: number, from: "chart" | "log") => void
  // Live: the ask the sweeps GET must answer next, or undefined once it
  // answered; `answer` hands its answer back for that ask.
  readonly awaiting: () => number | undefined
  readonly answer: (snapshot: number, answer: RecordedSweeps) => void
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: (change: SweepChange) => void) => () => void
}

// The selected code's sweeps, outside React like the candle store. A
// recorded day's come whole from its GET (`answer`). Live, each snapshot of
// this code asks the GET again: the trades deltas carry meanwhile wait for
// its answer, and only the trades numbered above the one it names are
// grouped onto it, so the join has no gap and no duplicate. A trade at or
// below that number that this store hasn't heard with the same side (a late
// trade, or a second feed changing its side) can change the answered sweeps,
// so it asks the GET again too.
export const makeSweepStore = (code: StockCode) =>
  Effect.sync((): SweepStore => {
    let answered: ReadonlyArray<Sweep> = []
    let through: TradeNumber | undefined
    // This code's regular-board trades after the answer, by trade number, the
    // newest of them, and their sweeps.
    let later = new Map<TradeNumber, RunningTrade>()
    let newest: TradeNumber | undefined
    let laterSweeps: Array<Sweep> = []
    let all: ReadonlyArray<Sweep> = []
    // Each trade number heard in a delta, with the side it last came with.
    const heard = new Map<TradeNumber, RunningTrade["side"]>()
    let ask = 0
    let waiting: Array<RunningTrade> | undefined
    let topN = TOP_N_DEFAULT
    let selected: number | undefined
    let worked:
      | {
          readonly sweeps: ReadonlyArray<Sweep>
          readonly topN: number
          readonly at: number
          readonly threshold: SweepThreshold
        }
      | undefined
    const listeners = new Set<(change: SweepChange) => void>()
    const emit = (change: SweepChange) => {
      for (const listener of listeners) listener(change)
    }
    const after = (trade: RunningTrade) =>
      through === undefined || TradeNumberOrder(trade.tradeNumber, through) > 0
    const add = (trades: ReadonlyArray<RunningTrade>) => {
      // The last copy of each trade number.
      const fresh = [
        ...new Map(
          trades.filter(after).map((trade) => [trade.tradeNumber, trade])
        ).values(),
      ].sort((a, b) => TradeNumberOrder(a.tradeNumber, b.tradeNumber))
      if (fresh.length === 0) return
      // A late trade can split a sweep already grouped, and a trade sent
      // again can change its side: group them all again.
      const regroup =
        newest !== undefined &&
        (TradeNumberOrder(fresh[0]!.tradeNumber, newest) <= 0 ||
          fresh.some((trade) => later.has(trade.tradeNumber)))
      for (const trade of fresh) later.set(trade.tradeNumber, trade)
      newest = fresh.at(-1)!.tradeNumber
      if (regroup) {
        const ordered = [...later.values()].sort((a, b) =>
          TradeNumberOrder(a.tradeNumber, b.tradeNumber)
        )
        newest = ordered.at(-1)!.tradeNumber
        laterSweeps = Effect.runSync(sweepsOf(ordered))
      } else Effect.runSync(addToSweeps(laterSweeps, fresh))
      all = Effect.runSync(joinSweeps(answered, laterSweeps))
      emit({ _tag: "Sweeps" })
    }
    const askAgain = (held: ReadonlyArray<RunningTrade>) => {
      ask += 1
      waiting = [...held]
      emit({ _tag: "Sweeps" })
    }
    return {
      code,
      sweeps: () => all,
      topN: () => topN,
      setTopN: (percent) => {
        if (percent === topN) return
        topN = percent
        emit({ _tag: "TopN" })
      },
      threshold: (at) => {
        if (worked?.sweeps !== all || worked.topN !== topN || worked.at !== at)
          worked = {
            sweeps: all,
            topN,
            at,
            threshold: Effect.runSync(sweepThreshold(all, topN, at)),
          }
        return worked.threshold
      },
      selected: () => selected,
      select: (id, from) => {
        const sweep = all[id]
        if (sweep === undefined) return
        selected = id
        emit({
          _tag: "Selected",
          id,
          minute: Effect.runSync(sweepMinute(sweep)),
          from,
        })
      },
      awaiting: () => (waiting === undefined ? undefined : ask),
      answer: (asked, answer) => {
        if (answer.code !== code || asked !== ask) return
        answered = answer.sweeps
        through = answer.through
        later = new Map()
        newest = undefined
        laterSweeps = []
        all = answered
        const held = waiting ?? []
        waiting = undefined
        selected = undefined
        emit({ _tag: "Sweeps" })
        add(held)
      },
      apply: (message) => {
        if (message._tag === "Snapshot") {
          if (message.selected === code) askAgain([])
          return
        }
        const mine = message.tape.filter(
          (trade) => trade.code === code && trade.board === "RG"
        )
        if (mine.length === 0) return
        let revised = false
        for (const trade of mine) {
          if (!after(trade) && heard.get(trade.tradeNumber) !== trade.side)
            revised = true
          heard.set(trade.tradeNumber, trade.side)
        }
        if (waiting !== undefined) waiting.push(...mine)
        else if (revised) askAgain(mine)
        else add(mine)
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
