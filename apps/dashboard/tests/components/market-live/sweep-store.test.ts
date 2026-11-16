import {
  BrokerCode,
  MINUTE_MS,
  StockCode,
  TradeNumber,
  type Sweep,
  type SweepPiece,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  makeSweepStore,
  type SweepChange,
} from "@/components/market-live/sweep-store"

const UNTR = StockCode.make("UNTR")
const BBCA = StockCode.make("BBCA")

const snapshot: ViewerDown = {
  _tag: "Snapshot",
  selected: UNTR,
  tape: [],
  candles: [],
  footprints: [],
  conditions: {
    phase: "session-1",
    relayOnline: true,
    feeds: { Stockbit: "live", Ajaib: "live" },
    gaps: [],
  },
}

// A sweep as the tests write it: its first trade's number, WIB time, side,
// lots and trade count.
const sweep = (
  firstTrade: number,
  time: string,
  side: Sweep["side"],
  lots: number,
  trades = 1
): Sweep => ({
  side,
  firstTrade: TradeNumber.make(String(firstTrade)),
  time: DateTime.makeUnsafe(`2026-11-09T${time}+07:00`),
  first: 1_000,
  last: 1_000,
  lots,
  value: lots * 100_000,
  trades,
})

// A delta carrying one minute's sweeps of `code`, whole; the minute is the
// WIB time's, `09:00`.
const delta = (
  minute: string,
  sweeps: ReadonlyArray<Sweep>,
  code = UNTR
): ViewerDown => ({
  _tag: "Delta",
  tape: [],
  candles: [],
  sweeps: [
    {
      code,
      minute: DateTime.makeUnsafe(`2026-11-09T${minute}:00+07:00`),
      sweeps,
    },
  ],
})

const answerOf = (sweeps: ReadonlyArray<Sweep>) => ({ code: UNTR, sweeps })

// A sweep as the test compares it: [first trade, side, lots, trades].
const shape = (shown: Sweep) => [
  shown.firstTrade,
  shown.side,
  shown.lots,
  shown.trades,
]

describe("the selected code's sweeps, live", () => {
  it.effect(
    "a snapshot asks the GET, whose answer shows; a minute a delta carries replaces the answer's copy of it and no other minute",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        const asked = store.awaiting()
        expect(asked).toBe(1)
        store.answer(
          asked!,
          answerOf([
            sweep(101, "09:00:10.100", "buy", 5, 2),
            sweep(104, "09:01:02.000", "sell", 1),
          ])
        )
        expect(store.awaiting()).toBeUndefined()
        // A late 102 split 09:00's sweep.
        store.apply(
          delta("09:00", [
            sweep(101, "09:00:10.100", "buy", 2),
            sweep(102, "09:00:10.200", "sell", 4),
            sweep(103, "09:00:10.500", "buy", 3),
          ])
        )
        expect(store.sweeps().map(shape)).toEqual([
          ["101", "buy", 2, 1],
          ["102", "sell", 4, 1],
          ["103", "buy", 3, 1],
          ["104", "sell", 1, 1],
        ])
        expect(store.awaiting()).toBeUndefined()
      })
  )

  it.effect(
    "a minute a delta carried while the GET was on its way wins over the answer's copy of it",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        // Sent after the answer was given: 09:01 with 105 joined on.
        store.apply(delta("09:01", [sweep(104, "09:01:02.000", "sell", 3, 2)]))
        store.answer(
          1,
          answerOf([
            sweep(101, "09:00:10.100", "buy", 5, 2),
            sweep(104, "09:01:02.000", "sell", 1),
          ])
        )
        expect(store.sweeps().map(shape)).toEqual([
          ["101", "buy", 5, 2],
          ["104", "sell", 3, 2],
        ])
      })
  )

  it.effect(
    "a minute a delta carries with no sweeps left is emptied, and a new minute is added in minute order",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        store.answer(
          1,
          answerOf([
            sweep(101, "09:00:10.100", "buy", 5, 2),
            sweep(104, "09:02:02.000", "sell", 1),
          ])
        )
        store.apply(delta("09:02", []))
        store.apply(delta("09:03", [sweep(107, "09:03:01.000", "buy", 2)]))
        // A late trade in a minute between the two.
        store.apply(delta("09:01", [sweep(103, "09:01:30.000", "sell", 6)]))
        expect(store.sweeps().map(shape)).toEqual([
          ["101", "buy", 5, 2],
          ["103", "sell", 6, 1],
          ["107", "buy", 2, 1],
        ])
      })
  )

  it.effect("another code's minute changes nothing", () =>
    Effect.gen(function* () {
      const store = yield* makeSweepStore(UNTR)
      store.apply(snapshot)
      store.answer(1, answerOf([sweep(101, "09:00:10.100", "buy", 5, 2)]))
      const before = store.sweeps()
      store.apply(delta("09:00", [sweep(102, "09:00:10.200", "sell", 9)], BBCA))
      expect(store.sweeps()).toBe(before)
    })
  )

  it.effect(
    "a new snapshot asks the GET again and drops the minutes deltas carried before it, which its answer is newer than",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        store.answer(1, answerOf([sweep(101, "09:00:10.100", "buy", 2)]))
        store.apply(delta("09:00", [sweep(101, "09:00:10.100", "buy", 5, 2)]))
        // The socket dropped and missed a late 102; it connected again.
        store.apply(snapshot)
        expect(store.awaiting()).toBe(2)
        store.answer(
          2,
          answerOf([
            sweep(101, "09:00:10.100", "buy", 2),
            sweep(102, "09:00:10.200", "sell", 4),
            sweep(103, "09:00:10.500", "buy", 3),
          ])
        )
        expect(store.sweeps().map(shape)).toEqual([
          ["101", "buy", 2, 1],
          ["102", "sell", 4, 1],
          ["103", "buy", 3, 1],
        ])
      })
  )

  it.effect("an answer for an earlier snapshot is dropped", () =>
    Effect.gen(function* () {
      const store = yield* makeSweepStore(UNTR)
      store.apply(snapshot)
      store.apply(snapshot)
      store.answer(1, answerOf([sweep(101, "09:00:10.100", "buy", 2)]))
      expect(store.awaiting()).toBe(2)
      expect(store.sweeps()).toEqual([])
    })
  )

  it.effect(
    "the selection stays on its sweep when a late trade splits an earlier one, and a re-asked GET keeps it",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.apply(snapshot)
        store.answer(
          1,
          answerOf([
            sweep(101, "09:00:10.100", "buy", 5, 2),
            sweep(105, "09:00:20.000", "sell", 3),
          ])
        )
        const changes: Array<SweepChange> = []
        store.subscribe((change) => changes.push(change))
        const picked = TradeNumber.make("105")
        store.select(picked, "log")
        expect(changes).toEqual([
          {
            _tag: "Selected",
            id: picked,
            minute:
              Math.floor(
                DateTime.toEpochMillis(
                  DateTime.makeUnsafe("2026-11-09T09:00:20+07:00")
                ) / MINUTE_MS
              ) * MINUTE_MS,
            from: "log",
          },
        ])
        // A late 102 on the other side splits the sweep before it.
        const split = [
          sweep(101, "09:00:10.100", "buy", 2),
          sweep(102, "09:00:10.200", "sell", 4),
          sweep(103, "09:00:10.500", "buy", 3),
          sweep(105, "09:00:20.000", "sell", 3),
        ]
        store.apply(delta("09:00", split))
        const selected = () =>
          store
            .sweeps()
            .filter((shown) => shown.firstTrade === store.selected())
        expect(selected().map(shape)).toEqual([["105", "sell", 3, 1]])
        store.apply(snapshot)
        store.answer(2, answerOf(split))
        expect(selected().map(shape)).toEqual([["105", "sell", 3, 1]])
      })
  )

  it.effect("selecting a sweep the store doesn't hold selects nothing", () =>
    Effect.gen(function* () {
      const store = yield* makeSweepStore(UNTR)
      store.apply(snapshot)
      store.answer(1, answerOf([sweep(101, "09:00:10.100", "buy", 5, 2)]))
      store.select(TradeNumber.make("999"), "chart")
      expect(store.selected()).toBeUndefined()
    })
  )
})

describe("a recorded day's sweeps as their brokers land", () => {
  // 101's sell sweep of FZ 6 lots (101, 103) and XL 8 (102), then 104's
  // buy, not yet whole.
  const whole = sweep(101, "09:00:10.100", "sell", 14, 3)
  const after = sweep(104, "09:00:20.000", "buy", 2)
  const piece = (
    firstTrade: number,
    time: string,
    lots: number,
    aggressor: string
  ): SweepPiece => ({
    ...sweep(firstTrade, time, "sell", lots),
    aggressor: [{ code: BrokerCode.make(aggressor), investorType: "D", lots }],
    other: [],
  })
  const split = {
    code: UNTR,
    sweeps: [
      {
        firstTrade: whole.firstTrade,
        pieces: [
          piece(101, "09:00:10.100", 6, "FZ"),
          piece(102, "09:00:10.200", 8, "XL"),
        ],
      },
    ],
    complete: false,
  }

  it.effect(
    "swaps a whole sweep for its pieces, and moves a pin and a selection on it to its largest piece",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.answer(0, answerOf([whole, after]))
        store.answerBrokers({ code: UNTR, sweeps: [], complete: false })
        store.select(whole.firstTrade, "log")
        store.tip.set({
          id: whole.firstTrade,
          x: 1,
          y: 2,
          from: "log",
          pinned: true,
        })
        store.answerBrokers(split)
        expect(store.sweeps().map(shape)).toEqual([
          ["101", "sell", 6, 1],
          ["102", "sell", 8, 1],
          ["104", "buy", 2, 1],
        ])
        expect(store.selected()).toBe("102")
        expect(store.tip.get()).toEqual({
          id: "102",
          x: 1,
          y: 2,
          from: "log",
          pinned: true,
        })
        expect(store.brokers().get(TradeNumber.make("101"))?.aggressor).toEqual(
          [{ code: "FZ", investorType: "D", lots: 6 }]
        )
      })
  )

  it.effect(
    "leaves a pin on a piece where it is as the next recheck lands",
    () =>
      Effect.gen(function* () {
        const store = yield* makeSweepStore(UNTR)
        store.answer(0, answerOf([whole, after]))
        store.answerBrokers(split)
        store.select(whole.firstTrade, "chart")
        store.answerBrokers({ ...split, complete: true })
        expect(store.selected()).toBe("101")
      })
  )
})
