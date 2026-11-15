import type {
  RecordedSweepBrokers,
  RecordedSweeps,
  StockCode,
  Sweep,
  SweepBrokers,
  TradeNumber,
  ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  TOP_N_DEFAULT,
  sweepMinute,
  sweepThreshold,
  type SweepThreshold,
} from "@/lib/sweeps"

// What changed since the listener last heard: the sweeps, their brokers,
// the top-N, or the selected sweep. A selection carries its minute, so whatever shows it can
// jump there: chart 1 scrolls to it, the sweep log scrolls to its row, and
// chart 2 can move to it (apinrdw/kumora#268).
export type SweepChange =
  | { readonly _tag: "Sweeps" }
  | { readonly _tag: "Brokers" }
  | { readonly _tag: "TopN" }
  | {
      readonly _tag: "Selected"
      readonly id: TradeNumber
      readonly minute: number
      // Where it was picked: a bubble on chart 1, or a row of the log.
      readonly from: "chart" | "log"
    }

export interface SweepStore {
  readonly code: StockCode
  // The selected code's sweeps and auction matches so far, in trade order.
  // A sweep's first trade's number is its id.
  readonly sweeps: () => ReadonlyArray<Sweep>
  // A recorded day's whole sweeps' brokers by first trade, the whole day's
  // as its sweep brokers GET last answered; the page cuts them at the
  // cursor as it does the sweeps. Empty live and until the GET answers.
  readonly brokers: () => ReadonlyMap<TradeNumber, SweepBrokers>
  readonly answerBrokers: (answer: RecordedSweepBrokers) => void
  readonly topN: () => number
  readonly setTopN: (percent: number) => void
  // The top-N threshold over the sweeps up to `at` (epoch ms; live, the end
  // of time), worked out once for the bubbles, the log and the control.
  readonly threshold: (at: number) => SweepThreshold
  // The selected sweep's id. It names that sweep or, once a late trade took
  // its first trade's place, none: never another.
  readonly selected: () => TradeNumber | undefined
  readonly select: (id: TradeNumber, from: "chart" | "log") => void
  // Live: the ask the sweeps GET must answer next, or undefined once it
  // answered; `answer` hands its answer back for that ask.
  readonly awaiting: () => number | undefined
  readonly answer: (asked: number, answer: RecordedSweeps) => void
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: (change: SweepChange) => void) => () => void
}

// The selected code's sweeps, outside React like the candle store, by
// minute. A recorded day's come whole from its GET (`answer`). Live, each
// snapshot of this code asks the GET again, and a delta carries each minute
// whose sweeps changed, whole, as the trading-day object holds them
// (candles.ts, `takeChanged`): a minute a delta carried since the snapshot
// wins over the answer's copy of it. The object sends every change after the
// snapshot and gives the answer after it too, so whichever of a minute's two
// copies is older, a later delta replaces it: the join has no gap and no
// duplicate, and the page groups nothing. The minutes heard before a
// snapshot are dropped, since the socket may have missed changes to them.
export const makeSweepStore = (code: StockCode) =>
  Effect.sync((): SweepStore => {
    // Each minute's sweeps: the last answer's, and those deltas carried
    // since the last snapshot.
    let answered: ReadonlyMap<number, ReadonlyArray<Sweep>> = new Map()
    const carried = new Map<number, ReadonlyArray<Sweep>>()
    let all: ReadonlyArray<Sweep> = []
    let brokers: ReadonlyMap<TradeNumber, SweepBrokers> = new Map()
    let ask = 0
    let asking = false
    let topN = TOP_N_DEFAULT
    let selected: TradeNumber | undefined
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
    const show = () => {
      all = [...new Map([...answered, ...carried])]
        .sort(([a], [b]) => a - b)
        .flatMap(([, sweeps]) => sweeps)
      emit({ _tag: "Sweeps" })
    }
    return {
      code,
      sweeps: () => all,
      brokers: () => brokers,
      answerBrokers: (answer) => {
        if (answer.code !== code) return
        brokers = new Map(
          answer.sweeps.map((sweep) => [sweep.firstTrade, sweep])
        )
        emit({ _tag: "Brokers" })
      },
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
        const sweep = all.find((shown) => shown.firstTrade === id)
        if (sweep === undefined) return
        selected = id
        emit({
          _tag: "Selected",
          id,
          minute: Effect.runSync(sweepMinute(sweep)),
          from,
        })
      },
      awaiting: () => (asking ? ask : undefined),
      answer: (asked, answer) => {
        if (answer.code !== code || asked !== ask) return
        asking = false
        const byMinute = new Map<number, Array<Sweep>>()
        for (const sweep of answer.sweeps) {
          const minute = Effect.runSync(sweepMinute(sweep))
          const sweeps = byMinute.get(minute)
          if (sweeps === undefined) byMinute.set(minute, [sweep])
          else sweeps.push(sweep)
        }
        answered = byMinute
        show()
      },
      apply: (message) => {
        if (message._tag === "Snapshot") {
          if (message.selected !== code) return
          // Shown until the answer replaces them.
          answered = new Map([...answered, ...carried])
          carried.clear()
          ask += 1
          asking = true
          emit({ _tag: "Sweeps" })
          return
        }
        const mine = (message.sweeps ?? []).filter(
          (minute) => minute.code === code
        )
        if (mine.length === 0) return
        for (const minute of mine)
          carried.set(DateTime.toEpochMillis(minute.minute), minute.sweeps)
        show()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
