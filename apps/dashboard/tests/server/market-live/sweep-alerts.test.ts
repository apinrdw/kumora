// The alert rule of spec apinrdw/kumora#510 (ticket apinrdw/kumora#512): one
// code's minutes of sweeps go in as the candle book regroups them, with the
// latest trade time the object holds and the decision instant, and the test
// reads which sweeps alert. The test plays the book: it keeps each minute's
// ranked sweeps and hands them back on the minute's next regroup.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, TradeNumber, type Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { makeSweepAlerts } from "@/server/market-live/sweep-alerts"

const UNTR = StockCode.make("UNTR")
const OPEN = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-09T02:00:00Z"))

let numbers = 0

// Seconds after 09:00 WIB: long after any sweep a test decides is fresh.
const LATER = 3600

// A sweep `second` seconds after 09:00 WIB.
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

// The rule, with each minute's ranked sweeps kept as the book keeps them.
const book = Effect.gen(function* () {
  const rule = yield* makeSweepAlerts
  const ranked = new Map<number, ReadonlyArray<Sweep>>()
  // One minute's sweeps, whole, decided once the latest trade is timed
  // `latest` seconds after 09:00 WIB and `now` seconds after it is the
  // decision instant. Returns the lots of the sweeps that alerted.
  const regroup = Effect.fnUntraced(function* (
    minute: number,
    sweeps: ReadonlyArray<Sweep>,
    latest: number,
    now = latest
  ) {
    const decided = yield* rule.decide(
      UNTR,
      ranked.get(minute) ?? [],
      sweeps,
      OPEN + latest * 1000,
      OPEN + now * 1000
    )
    ranked.set(minute, decided.ranked)
    return decided.alerts.map((alert) => [alert.side, alert.lots])
  })
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
  return { regroup, warm }
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
        // A late trade grows it to 160.
        assert.deepStrictEqual(
          yield* day.regroup(0, [{ ...first, lots: 160 }], 3),
          []
        )
        // 101 sweeps cut at the 2nd largest: 100, the 150 replaced by 160.
        assert.deepStrictEqual(
          yield* day.regroup(1, [sweep("buy", 4, 149)], 5),
          [["buy", 149]]
        )
        // Another late trade splits a sweep off in the decided second.
        assert.deepStrictEqual(
          yield* day.regroup(
            0,
            [{ ...first, lots: 160 }, sweep("buy", 1, 500)],
            6
          ),
          []
        )
      })
  )
})
