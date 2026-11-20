import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeProgress } from "../../src/worker/broker-codes/progress.ts"
import type { BrokerCodesProgress } from "../../src/worker/broker-codes/run-queue.ts"

const DAY = WibDate.make("2026-11-12")
const WALKING: BrokerCodesProgress = {
  state: "walking",
  walk: "newest",
  day: DAY,
  feed: "Stockbit",
}

const harness = Effect.fnUntraced(function* () {
  const saved: Array<BrokerCodesProgress> = []
  const progress = yield* makeProgress((each) =>
    Effect.sync(() => {
      saved.push(each)
    })
  )
  return { saved, progress }
})

describe("the broker codes progress", () => {
  it.effect("shows a walk's trades of N, and its pace once it has one", () =>
    Effect.gen(function* () {
      const { saved, progress } = yield* harness()
      yield* progress.report(WALKING)
      yield* progress.trades(1_000, Option.some(1_000_000))
      assert.deepStrictEqual(saved.at(-1), {
        ...WALKING,
        trades: { fetched: 1_000, of: 1_000_000, perSecond: null },
      })
      yield* TestClock.adjust("10 seconds")
      yield* progress.trades(4_000, Option.some(1_000_000))
      assert.deepStrictEqual(saved.at(-1), {
        ...WALKING,
        trades: { fetched: 4_000, of: 1_000_000, perSecond: 300 },
      })
      // The next walk starts without the last one's trades.
      yield* progress.report({ ...WALKING, walk: "gaps" })
      assert.deepStrictEqual(saved.at(-1), { ...WALKING, walk: "gaps" })
    })
  )

  it.effect(
    "writes a walk's phase at once, and the next walk starts without it",
    () =>
      Effect.gen(function* () {
        const { saved, progress } = yield* harness()
        yield* progress.report(WALKING)
        yield* progress.trades(100, Option.none())
        yield* progress.phase({ step: "fetching", since: 1 })
        assert.lengthOf(saved, 3)
        assert.deepStrictEqual(
          saved.at(-1)?.state === "walking" && saved.at(-1),
          {
            ...WALKING,
            phase: { step: "fetching", since: 1 },
            trades: { fetched: 100, of: null, perSecond: null },
          }
        )
        yield* progress.report(WALKING)
        assert.deepStrictEqual(saved.at(-1), WALKING)
      })
  )

  it.effect("writes a walk's trades at most once a second", () =>
    Effect.gen(function* () {
      const { saved, progress } = yield* harness()
      yield* progress.report(WALKING)
      yield* progress.trades(100, Option.none())
      yield* TestClock.adjust("300 millis")
      yield* progress.trades(200, Option.none())
      assert.lengthOf(saved, 2)
      yield* TestClock.adjust("700 millis")
      yield* progress.trades(300, Option.none())
      assert.lengthOf(saved, 3)
    })
  )

  it.effect(
    "shows the repair pass's blocks and pace beside the first pass's trades",
    () =>
      Effect.gen(function* () {
        const { saved, progress } = yield* harness()
        const trades = { fetched: 9_000, of: 9_003, perSecond: null }
        yield* progress.report(WALKING)
        yield* progress.trades(9_000, Option.some(9_003))
        // The pass's start is written at once, within a second of the trades.
        yield* TestClock.adjust("200 millis")
        yield* progress.repair(0, 8)
        assert.deepStrictEqual(saved.at(-1), {
          ...WALKING,
          trades,
          repair: { done: 0, of: 8, perSecond: null },
        })
        yield* TestClock.adjust("40 seconds")
        yield* progress.repair(2, 8)
        assert.deepStrictEqual(saved.at(-1), {
          ...WALKING,
          trades,
          repair: { done: 2, of: 8, perSecond: 0.05 },
        })
        // The next walk starts without the last one's repair.
        yield* progress.report({ ...WALKING, walk: "gaps" })
        assert.deepStrictEqual(saved.at(-1), { ...WALKING, walk: "gaps" })
      })
  )

  it.effect("writes a repair pass's blocks at most once a second", () =>
    Effect.gen(function* () {
      const { saved, progress } = yield* harness()
      yield* progress.report(WALKING)
      yield* progress.repair(0, 8)
      yield* TestClock.adjust("300 millis")
      yield* progress.repair(1, 8)
      assert.lengthOf(saved, 2)
      yield* TestClock.adjust("700 millis")
      yield* progress.repair(2, 8)
      assert.lengthOf(saved, 3)
    })
  )

  it.effect(
    "shows Stockbit signed out while a walk waits on it, then the walk again",
    () =>
      Effect.gen(function* () {
        const { saved, progress } = yield* harness()
        yield* progress.report(WALKING)
        yield* progress.signedOut(true)
        assert.deepStrictEqual(saved.at(-1), {
          state: "paused",
          cause: "signed-out",
        })
        // The wait holds over the walk's own reports.
        yield* progress.report({ ...WALKING, walk: "history" })
        assert.deepStrictEqual(saved.at(-1), {
          state: "paused",
          cause: "signed-out",
        })
        yield* progress.signedOut(false)
        assert.deepStrictEqual(saved.at(-1), { ...WALKING, walk: "history" })
      })
  )
})
