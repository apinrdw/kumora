// The alert rule of spec apinrdw/kumora#510 (ticket apinrdw/kumora#512): one
// code's minutes of sweeps go in as the candle book regroups them, then the
// latest trade time the object holds and the decision instant, and the test
// reads which sweeps alert. The test plays the book: it hands a minute in
// whole on each regroup, and says when it lets one go.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, TradeNumber, type Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  makeSweepAlerts,
  type KnownSweep,
} from "@/server/market-live/sweep-alerts"

const UNTR = StockCode.make("UNTR")
const OPEN = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T02:00:00Z"))

let numbers = 0

// Seconds after 09:00 WIB: long after any sweep a test decides is fresh.
const LATER = 3600

// A sweep of one trade `second` seconds after 09:00 WIB.
const sweep = (
  side: Sweep["side"],
  second: number,
  lots: number,
  firstTrade = ++numbers
): Sweep => ({
  side,
  firstTrade: TradeNumber.make(String(firstTrade)),
  time: DateTime.makeUnsafe(OPEN + second * 1000),
  first: 100,
  last: 100,
  lots,
  value: lots * 100 * 100,
  trades: 1,
})

// A sweep of the trades numbered `trades`, the first its first.
const of = (
  one: Sweep,
  ...trades: readonly [number, ...Array<number>]
): KnownSweep => ({
  sweep: {
    ...one,
    firstTrade: TradeNumber.make(String(trades[0])),
    trades: trades.length,
  },
  trades: trades.map((trade) => TradeNumber.make(String(trade))),
})

// A sweep as the book hands it in: one given bare is known by its one trade.
const known = (one: Sweep | KnownSweep): KnownSweep =>
  "sweep" in one ? one : { sweep: one, trades: [one.firstTrade] }

// The rule, heard as the candle book hands it UNTR's minutes.
const book = Effect.gen(function* () {
  const rule = yield* makeSweepAlerts
  // One minute's sweeps as now grouped, whole. `stored` is what the store
  // held of the minute when the book took it.
  const group = (
    minute: number,
    sweeps: ReadonlyArray<Sweep | KnownSweep>,
    stored: ReadonlyArray<Sweep> = []
  ) =>
    rule.regroup({
      code: UNTR,
      minute,
      stored: stored.map(known),
      sweeps: sweeps.map(known),
    })
  // The decisions once the latest trade is timed `latest` seconds after
  // 09:00 WIB and `now` seconds after it is the decision instant: the side
  // and lots of each sweep that alerted.
  const decide = (latest: number, now = latest) =>
    Effect.map(
      rule.decide({ latest: OPEN + latest * 1000, now: OPEN + now * 1000 }),
      (standouts) =>
        standouts.flatMap((standout) =>
          standout.alerts ? [[standout.sweep.side, standout.sweep.lots]] : []
        )
    )
  // One minute regrouped and decided, as a delta with one changed minute.
  const regroup = (
    minute: number,
    sweeps: ReadonlyArray<Sweep | KnownSweep>,
    latest: number,
    now = latest,
    stored: ReadonlyArray<Sweep> = []
  ) => Effect.andThen(group(minute, sweeps, stored), decide(latest, now))
  // The book lets a minute go, its sweeps stored.
  const release = (minute: number) => rule.release(UNTR, minute)
  // `count` sweeps of `side`, one a second before 09:00 WIB, with the lots
  // `lotsOf` gives each, decided long after, each call a minute of its own.
  let warmed = 0
  const warm = (
    side: Sweep["side"],
    count: number,
    lotsOf: (index: number) => number = () => 1
  ) =>
    regroup(
      -++warmed,
      Array.from({ length: count }, (_, index) =>
        sweep(side, -count + index, lotsOf(index))
      ),
      0,
      LATER
    )
  return { group, decide, regroup, release, warm }
})

describe("sweep alerts", () => {
  it.effect(
    "a side stays silent until it holds 100 sweeps, each side counted alone",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 99)
        yield* day.warm("sell", 150)
        // 99 earlier buy sweeps: silent, however big.
        assert.deepStrictEqual(
          yield* day.regroup(0, [sweep("buy", 1, 500)], 2),
          []
        )
        // Now 100: the next big one alerts.
        assert.deepStrictEqual(
          yield* day.regroup(
            0,
            [sweep("buy", 1, 500), sweep("buy", 2, 500)],
            3
          ),
          [["buy", 500]]
        )
        // 150 sell sweeps: the sell side is warm.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("sell", 4, 9)], 5),
          [["sell", 9]]
        )
      })
  )

  it.effect(
    "a sweep alerts at or above the cutoff of the earlier sweeps, a tie included, then joins them",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        // Lots 1 to 100: the cutoff of 100 sweeps is the largest, 100.
        yield* day.warm("buy", 100, (index) => index + 1)
        // Ranked with itself, 101 sweeps would cut at the 2nd largest, 99.
        assert.deepStrictEqual(
          yield* day.regroup(0, [sweep("buy", 1, 99)], 2),
          []
        )
        // That 99 joined: 101 sweeps cut at the 2nd largest, now 99.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("buy", 2, 99)], 3),
          [["buy", 99]]
        )
        // A tie with the cutoff alerts: 102 sweeps, 2nd largest 99.
        assert.deepStrictEqual(
          yield* day.regroup(2, [sweep("buy", 3, 98), sweep("buy", 4, 99)], 5),
          [["buy", 99]]
        )
      })
  )

  it.effect(
    "a sweep alerts only once its second closed, at the first regroup after a later trade",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("sell", 100)
        const big = sweep("sell", 1, 50)
        // The latest trade is still in its second: nothing decided yet.
        assert.deepStrictEqual(yield* day.regroup(0, [big], 1.9), [])
        assert.deepStrictEqual(yield* day.regroup(0, [big], 2), [["sell", 50]])
      })
  )

  it.effect(
    "a sweep whose second closed more than 10 s before the decision stays silent, yet ranks and warms its side up",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 100)
        // Its second closed at 2 s: decided at 12 s it still alerts...
        assert.deepStrictEqual(
          yield* day.regroup(0, [sweep("buy", 1, 1)], 2, 12),
          [["buy", 1]]
        )
        // ...at 12.001 s it is silent, though above the cutoff.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("buy", 20, 400)], 21, 31.001),
          []
        )
        assert.deepStrictEqual(
          yield* day.regroup(2, [sweep("buy", 40, 300)], 41),
          [["buy", 300]]
        )
        // It ranked: 103 sweeps cut at the 2nd largest, 300, not 1.
        assert.deepStrictEqual(
          yield* day.regroup(3, [sweep("buy", 50, 299)], 51),
          []
        )

        // A late sweep counts toward the warm-up too.
        const quiet = yield* book
        yield* quiet.warm("sell", 99)
        assert.deepStrictEqual(
          yield* quiet.regroup(0, [sweep("sell", 1, 1)], 2, 60),
          []
        )
        assert.deepStrictEqual(
          yield* quiet.regroup(1, [sweep("sell", 70, 1)], 71),
          [["sell", 1]]
        )
      })
  )

  it.effect("an auction match neither alerts nor warms a side up", () =>
    Effect.gen(function* () {
      const day = yield* book
      yield* day.warm("none", 150)
      yield* day.warm("buy", 99)
      assert.deepStrictEqual(
        yield* day.regroup(0, [sweep("none", 1, 900), sweep("buy", 2, 900)], 3),
        []
      )
    })
  )

  it.effect(
    "a regroup of a decided second replaces its sweep's entry and never alerts again",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 100, (index) => index + 1)
        const first = sweep("buy", 1, 150)
        assert.deepStrictEqual(yield* day.regroup(0, [first], 2), [
          ["buy", 150],
        ])
        // A late trade, numbered two after its one, grows it to 160.
        const at = Number(first.firstTrade)
        numbers = at + 2
        assert.deepStrictEqual(
          yield* day.regroup(0, [of({ ...first, lots: 160 }, at, at + 2)], 3),
          []
        )
        // 101 sweeps cut at the 2nd largest: 100, the 150 replaced by 160.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("buy", 4, 149)], 5),
          [["buy", 149]]
        )
        // A late sell trade splits it in two: neither buy piece alerts again.
        assert.deepStrictEqual(
          yield* day.regroup(
            0,
            [
              { ...first, lots: 60 },
              sweep("sell", 1, 1, at + 1),
              sweep("buy", 1, 100, at + 2),
            ],
            6
          ),
          []
        )
      })
  )

  it.effect(
    "a new sweep in an already decided second is decided under the rule, the age limit included",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 100, () => 100)
        const small = sweep("buy", 1, 1)
        const sell = sweep("sell", 1, 1)
        assert.deepStrictEqual(yield* day.regroup(0, [small, sell], 2), [])
        // A buy trade numbered after the sell arrives late: a sweep of its own.
        const late = sweep("buy", 1, 500)
        assert.deepStrictEqual(yield* day.regroup(0, [small, sell, late], 3), [
          ["buy", 500],
        ])
        // Another, decided more than 10 s after its second closed: silent.
        assert.deepStrictEqual(
          yield* day.regroup(
            0,
            [small, sell, late, sweep("sell", 1, 1), sweep("buy", 1, 900)],
            4,
            12.001
          ),
          []
        )
        // It still ranked: 103 sweeps cut at the 2nd largest, 500.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("buy", 70, 499)], 71),
          []
        )
      })
  )

  it.effect(
    "a sweep that holds none of a ranked sweep's trades is new, wherever its trades are numbered",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 100)
        // Trades 1001 and 1005 make one buy sweep, the minute's last.
        assert.deepStrictEqual(
          yield* day.regroup(0, [of(sweep("buy", 1, 80), 1001, 1005)], 2),
          [["buy", 80]]
        )
        // Late trades land between its two and after them. Its halves are
        // regroups; the buy between them and the buy after them are new.
        assert.deepStrictEqual(
          yield* day.regroup(
            0,
            [
              of(sweep("buy", 1, 30), 1001),
              of(sweep("sell", 1, 1), 1002),
              of(sweep("buy", 1, 70), 1003),
              of(sweep("sell", 1, 1), 1004),
              of(sweep("buy", 1, 50), 1005),
              of(sweep("sell", 1, 1), 1006),
              of(sweep("buy", 1, 60), 1007),
            ],
            3
          ),
          [
            ["buy", 70],
            ["buy", 60],
          ]
        )
      })
  )

  it.effect(
    "a sweep that waits while the book lets its minute go and takes it again is decided once, against the sweeps before it",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 99)
        const big = sweep("buy", 1, 100)
        // The 100th buy sweep's second, the latest, is open.
        assert.deepStrictEqual(yield* day.regroup(0, [big], 1), [])
        yield* day.release(0)
        // A trade reopens the minute, the store holding the waiting sweep,
        // and closes its second: 99 before it, so it is silent.
        const next = sweep("buy", 2, 50)
        assert.deepStrictEqual(
          yield* day.regroup(0, [big, next], 2, 2, [big]),
          []
        )
        // Each ranked once. 100 sweeps cut at the largest, 100 lots, so the
        // 50 are silent; 101 cut at the 2nd largest, those 50, so 60 alert.
        assert.deepStrictEqual(
          yield* day.regroup(0, [big, next, sweep("buy", 3, 60)], 4, 4, [big]),
          [["buy", 60]]
        )
      })
  )

  it.effect(
    "a sweep that waits is decided once its second closes though the book let its minute go, and the stored minute then counts as ranked",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("sell", 100)
        const big = sweep("sell", 1, 50)
        assert.deepStrictEqual(yield* day.regroup(0, [big], 1), [])
        yield* day.release(0)
        // No minute regrouped: another code's trade closed the second.
        assert.deepStrictEqual(yield* day.decide(2), [["sell", 50]])
        // The book takes the minute from the store for a later trade: the
        // big sweep neither alerts nor ranks again.
        const next = sweep("sell", 3, 40)
        assert.deepStrictEqual(
          yield* day.regroup(0, [big, next], 4, 4, [big]),
          // 101 sweeps cut at the 2nd largest, one lot.
          [["sell", 40]]
        )
        // 102 cut at the 2nd largest: 40. Ranked twice, the big one's 50.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("sell", 5, 45)], 6),
          [["sell", 45]]
        )
      })
  )

  it.effect(
    "minutes are decided in trade order, whichever the book regrouped first",
    () =>
      Effect.gen(function* () {
        const day = yield* book
        yield* day.warm("buy", 98)
        // The 100th buy sweep waits in its minute's last second.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("buy", 119, 1)], 119),
          []
        )
        // One delta regroups the next minute, then one before both for a
        // late trade: the 99th, 100th and 101st in trade order.
        yield* day.group(2, [sweep("buy", 120, 500)])
        yield* day.group(0, [sweep("buy", 59, 1)])
        assert.deepStrictEqual(yield* day.decide(121), [["buy", 500]])
      })
  )
})
