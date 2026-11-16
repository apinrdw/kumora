import type {
  BrokerCode,
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
  keptSweeps,
  sweepMinute,
  sweepThreshold,
  type KeptSweep,
  type SweepThreshold,
} from "@/lib/sweeps"

import { makeListenerStore, type ListenerStore } from "./listener-store"

// What changed since the listener last heard: the sweeps, their brokers,
// the top-N, the picked broker, or the selected sweep. A selection carries its minute, so whatever shows it can
// jump there: the candle chart scrolls to it, the sweep log scrolls to its row,
// and the footprint chart can move to it (apinrdw/kumora#268).
export type SweepChange =
  | { readonly _tag: "Sweeps" }
  | { readonly _tag: "Brokers" }
  | { readonly _tag: "TopN" }
  | { readonly _tag: "Picked" }
  | {
      readonly _tag: "Selected"
      readonly id: TradeNumber
      readonly minute: number
      // Where it was picked: a bubble on the candle chart, or a row of the log.
      readonly from: "chart" | "log"
    }

// Where the sweep tooltip shows, for which sweep: at a point of the
// viewport, from a bubble on the candle chart or a broker cell of the log.
export interface TipAt {
  readonly id: TradeNumber
  readonly x: number
  readonly y: number
  readonly from: "chart" | "log"
  // Shown by a click or a tap, not a hover: a hover leaves it be.
  readonly pinned: boolean
}

export interface SweepStore {
  readonly code: StockCode
  // The sweep tooltip's place, apart from the changes below so a hover
  // redraws no bubble; none while it is hidden.
  readonly tip: ListenerStore<TipAt | undefined>
  // The selected code's sweeps and auction matches so far, in trade order.
  // A sweep's first trade's number is its id.
  readonly sweeps: () => ReadonlyArray<Sweep>
  // A recorded day's whole sweeps' brokers by first trade, the whole day's
  // as its sweep brokers GET last answered; the page cuts them at the
  // cursor as it does the sweeps. Empty live and until the GET answers.
  readonly brokers: () => ReadonlyMap<TradeNumber, SweepBrokers>
  // Whether the day's codes are complete, as the sweep brokers GET last
  // answered; true until it answers otherwise, so live shows no note.
  readonly brokersComplete: () => boolean
  readonly answerBrokers: (answer: RecordedSweepBrokers) => void
  // The broker the log and the candle chart's bubbles are filtered to, or
  // none for all.
  // Decision: it lives here, per code and per page, not in the URL or the
  // chart settings: the spec keeps it across neither a code switch nor a
  // reload (apinrdw/kumora#343, "The filter control").
  readonly picked: () => BrokerCode | undefined
  readonly pick: (broker: BrokerCode | undefined) => void
  // The sweeps the picked broker's filter keeps, with their own lots: all
  // of them when none is picked.
  readonly kept: () => ReadonlyArray<KeptSweep>
  readonly topN: () => number
  readonly setTopN: (percent: number) => void
  // The top-N threshold over the kept sweeps up to `at` (epoch ms; live,
  // the end of time), worked out once for the bubbles, the log and the
  // control.
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
  Effect.gen(function* () {
    const tip = yield* makeListenerStore<TipAt | undefined>(undefined)
    // Each minute's sweeps: the last answer's, and those deltas carried
    // since the last snapshot.
    let answered: ReadonlyMap<number, ReadonlyArray<Sweep>> = new Map()
    const carried = new Map<number, ReadonlyArray<Sweep>>()
    let all: ReadonlyArray<Sweep> = []
    let brokers: ReadonlyMap<TradeNumber, SweepBrokers> = new Map()
    let brokersComplete = true
    let ask = 0
    let asking = false
    let topN = TOP_N_DEFAULT
    let picked: BrokerCode | undefined
    let selected: TradeNumber | undefined
    let keeping:
      | {
          readonly sweeps: ReadonlyArray<Sweep>
          readonly brokers: ReadonlyMap<TradeNumber, SweepBrokers>
          readonly picked: BrokerCode | undefined
          readonly kept: ReadonlyArray<KeptSweep>
        }
      | undefined
    const kept = () => {
      if (
        keeping?.sweeps !== all ||
        keeping.brokers !== brokers ||
        keeping.picked !== picked
      )
        keeping = {
          sweeps: all,
          brokers,
          picked,
          kept: Effect.runSync(keptSweeps(all, brokers, picked)),
        }
      return keeping.kept
    }
    let worked:
      | {
          readonly sweeps: ReadonlyArray<KeptSweep>
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
    const store: SweepStore = {
      code,
      tip,
      sweeps: () => all,
      brokers: () => brokers,
      brokersComplete: () => brokersComplete,
      answerBrokers: (answer) => {
        if (answer.code !== code) return
        brokersComplete = answer.complete
        brokers = new Map(
          answer.sweeps.map((sweep) => [sweep.firstTrade, sweep])
        )
        emit({ _tag: "Brokers" })
      },
      picked: () => picked,
      pick: (broker) => {
        if (broker === picked) return
        picked = broker
        emit({ _tag: "Picked" })
      },
      kept,
      topN: () => topN,
      setTopN: (percent) => {
        if (percent === topN) return
        topN = percent
        emit({ _tag: "TopN" })
      },
      threshold: (at) => {
        const sweeps = kept()
        if (
          worked?.sweeps !== sweeps ||
          worked.topN !== topN ||
          worked.at !== at
        )
          worked = {
            sweeps,
            topN,
            at,
            threshold: Effect.runSync(sweepThreshold(sweeps, topN, at)),
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
    return store
  })
