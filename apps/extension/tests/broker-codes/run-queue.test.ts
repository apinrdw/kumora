import { assert, describe, it } from "@effect/vitest"
import { WibDate, type Feed } from "@workspace/relay"
import { Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  makeRunQueue,
  type BrokerCodesProgress,
  type IncompleteDaysStore,
  type WalkResult,
} from "../../src/worker/broker-codes/run-queue.ts"

const wib = (date: string, time: string) => Date.parse(`${date}T${time}+07:00`)

// A site's walk that answers `result` for every day, keeping the days asked.
const fakeWalk = (
  feed: Feed,
  walked: Array<string>,
  result: (day: WibDate) => Effect.Effect<WalkResult> = () =>
    Effect.succeed({ _tag: "walked" })
) => ({
  feed,
  walk: (day: WibDate) =>
    Effect.suspend(() => {
      walked.push(`${feed} ${day}`)
      return result(day)
    }),
})

// The extra target's catch-up walk of a site, kept as `catch-up <feed> <day>`.
const catchUpWalk = (
  feed: Feed,
  walked: Array<string>,
  result: (day: WibDate) => Effect.Effect<WalkResult> = () =>
    Effect.succeed({ _tag: "walked" })
) => ({
  feed,
  walk: (day: WibDate) =>
    Effect.suspend(() => {
      walked.push(`catch-up ${feed} ${day}`)
      return result(day)
    }),
})

// Stockbit's gap walk of older days, kept as `gaps <day>`.
const gapWalk = (
  walked: Array<string>,
  result: (day: WibDate) => Effect.Effect<WalkResult> = () =>
    Effect.succeed({ _tag: "walked" })
) => ({
  feed: "Stockbit" as const,
  walk: (day: WibDate) =>
    Effect.suspend(() => {
      walked.push(`gaps ${day}`)
      return result(day)
    }),
})

// The incomplete-days list as chrome.storage.local keeps it.
const memoryDays = (days: ReadonlyArray<string> = []) => {
  let kept = days.map((day) => WibDate.make(day))
  return {
    days: () => kept,
    store: {
      load: Effect.sync(() => kept),
      save: (next: ReadonlyArray<WibDate>) =>
        Effect.sync(() => {
          kept = [...next]
        }),
    } satisfies IncompleteDaysStore,
  }
}

type Walks = (
  walked: Array<string>
) => ReadonlyArray<ReturnType<typeof fakeWalk>>

const harness = Effect.fnUntraced(function* (
  walks: Walks,
  catchUp: Walks = () => [],
  older: {
    readonly days?: ReturnType<typeof memoryDays>
    readonly gaps?: (day: WibDate) => Effect.Effect<WalkResult>
  } = {}
) {
  const walked: Array<string> = []
  const progress: Array<BrokerCodesProgress> = []
  const days = older.days ?? memoryDays()
  const queue = yield* makeRunQueue({
    newestDay: walks(walked),
    incompleteDays: days.store,
    gaps: gapWalk(walked, older.gaps),
    catchUp: catchUp(walked),
    report: (each) => Effect.sync(() => progress.push(each)),
  })
  yield* Effect.forkChild(queue.run)
  const settle = TestClock.adjust("0 millis")
  return {
    walked,
    progress,
    days,
    tick: Effect.andThen(queue.tick, settle),
    trigger: Effect.andThen(queue.trigger, settle),
  }
})

describe("the broker codes run queue", () => {
  it.effect(
    "walks the newest closed day on the first tick after 16:35, once",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "16:00:00"))
        const queue = yield* harness((walked) => [fakeWalk("Ajaib", walked)])
        // Market hours: nothing runs.
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, [])
        yield* TestClock.setTime(wib("2026-11-12", "16:35:00"))
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
        yield* TestClock.adjust("10 seconds")
        yield* queue.tick
        yield* TestClock.setTime(wib("2026-11-13", "02:00:00"))
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
        // Friday's close, then the weekend: still Friday's.
        yield* TestClock.setTime(wib("2026-11-13", "16:40:00"))
        yield* queue.tick
        yield* TestClock.setTime(wib("2026-11-14", "12:00:00"))
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "Ajaib 2026-11-13",
          "gaps 2026-11-12",
        ])
      })
  )

  it.effect(
    "a worker that starts in the morning walks the day before at once",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-13", "06:00:00"))
        const queue = yield* harness((walked) => [fakeWalk("Ajaib", walked)])
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
      })
  )

  it.effect(
    "runs the day's walks in order, past a site that can't serve the day",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness((walked) => [
          fakeWalk("Ajaib", walked, () =>
            Effect.succeed({ _tag: "unserved", reason: "no-tab" })
          ),
          fakeWalk("Stockbit", walked),
        ])
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "Stockbit 2026-11-12",
        ])
        assert.deepStrictEqual(queue.progress.at(-1), { state: "idle" })
      })
  )

  it.effect(
    "a walk stopped at 08:40 ends the run, and the queue runs again at 16:35",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness((walked) => [
          fakeWalk("Ajaib", walked, () =>
            Effect.succeed({ _tag: "stopped", cause: "market-hours" })
          ),
          fakeWalk("Stockbit", walked),
        ])
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
        assert.deepStrictEqual(queue.progress.at(-1), {
          state: "paused",
          cause: "market-hours",
        })
        yield* TestClock.setTime(wib("2026-11-13", "08:40:00"))
        yield* queue.tick
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
        yield* TestClock.setTime(wib("2026-11-13", "16:35:00"))
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "Ajaib 2026-11-13",
        ])
      })
  )

  it.effect("triggers during a run start one more run after it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const release = yield* Deferred.make<void>()
      const queue = yield* harness((walked) => [
        fakeWalk("Ajaib", walked, () =>
          Effect.as(Deferred.await(release), { _tag: "walked" } as const)
        ),
      ])
      yield* queue.trigger
      yield* queue.trigger
      yield* queue.trigger
      assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
      yield* Deferred.succeed(release, undefined)
      yield* TestClock.adjust("0 millis")
      assert.deepStrictEqual(queue.walked, [
        "Ajaib 2026-11-12",
        "Ajaib 2026-11-12",
      ])
    })
  )

  it.effect(
    "once the day's walks are done, the extra target's catch-up walks run",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked), fakeWalk("Stockbit", walked)],
          (walked) => [
            catchUpWalk("Ajaib", walked, () =>
              Effect.succeed({ _tag: "unserved", reason: "window-passed" })
            ),
            catchUpWalk("Stockbit", walked),
          ]
        )
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "Stockbit 2026-11-12",
          "catch-up Ajaib 2026-11-12",
          "catch-up Stockbit 2026-11-12",
        ])
        assert.deepStrictEqual(queue.progress.at(-1), { state: "idle" })
      })
  )

  it.effect("a catch-up gives way to the next run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const queue = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        (walked) => [catchUpWalk("Stockbit", walked, () => Effect.never)]
      )
      yield* queue.trigger
      assert.deepStrictEqual(queue.walked, [
        "Ajaib 2026-11-12",
        "catch-up Stockbit 2026-11-12",
      ])
      // A catch-up that never ends: a new day's run still starts at once.
      yield* TestClock.setTime(wib("2026-11-13", "16:35:00"))
      yield* queue.tick
      assert.deepStrictEqual(queue.walked.slice(2), [
        "Ajaib 2026-11-13",
        "gaps 2026-11-12",
        "catch-up Stockbit 2026-11-13",
      ])
    })
  )

  it.effect(
    "a catch-up the extra target stopped leaves Production's progress idle",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          (walked) => [
            catchUpWalk("Ajaib", walked, () =>
              Effect.succeed({ _tag: "stopped", cause: "rejected-token" })
            ),
            catchUpWalk("Stockbit", walked),
          ]
        )
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "catch-up Ajaib 2026-11-12",
        ])
        assert.deepStrictEqual(queue.progress.at(-1), { state: "idle" })
      })
  )
})

describe("the broker codes run queue: older incomplete days", () => {
  it.effect(
    "walks older days' gaps after the new day, oldest first, then the catch-up",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked), fakeWalk("Stockbit", walked)],
          (walked) => [catchUpWalk("Stockbit", walked)],
          { days: memoryDays(["2026-11-10", "2026-11-06", "2026-11-11"]) }
        )
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "Stockbit 2026-11-12",
          "gaps 2026-11-06",
          "gaps 2026-11-10",
          "gaps 2026-11-11",
          "catch-up Stockbit 2026-11-12",
        ])
        assert.deepStrictEqual(queue.progress.slice(-2), [
          {
            state: "walking",
            day: WibDate.make("2026-11-11"),
            feed: "Stockbit",
          },
          { state: "idle" },
        ])
      })
  )

  it.effect(
    "drops a day once complete or given up, and keeps one still incomplete",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const results: Record<string, WalkResult> = {
          "2026-11-06": { _tag: "walked" },
          "2026-11-10": { _tag: "unserved", reason: "no-rows" },
          "2026-11-11": { _tag: "unserved", reason: "incomplete" },
        }
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          undefined,
          {
            days: memoryDays(["2026-11-06", "2026-11-10", "2026-11-11"]),
            gaps: (day) => Effect.succeed(results[day] ?? { _tag: "walked" }),
          }
        )
        yield* queue.trigger
        // The new day is kept too, and checked once it is an older day.
        assert.deepStrictEqual(queue.days.days(), ["2026-11-11", "2026-11-12"])
      })
  )

  it.effect("a gap walk that stops ends the run and keeps its day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const queue = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        (walked) => [catchUpWalk("Stockbit", walked)],
        {
          days: memoryDays(["2026-11-06", "2026-11-10"]),
          gaps: () => Effect.succeed({ _tag: "stopped", cause: "no-tab" }),
        }
      )
      yield* queue.trigger
      assert.deepStrictEqual(queue.walked, [
        "Ajaib 2026-11-12",
        "gaps 2026-11-06",
      ])
      assert.deepStrictEqual(queue.progress.at(-1), {
        state: "paused",
        cause: "no-tab",
      })
      assert.deepStrictEqual(queue.days.days(), [
        "2026-11-06",
        "2026-11-10",
        "2026-11-12",
      ])
    })
  )

  it.effect("the list survives a restarted worker", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const days = memoryDays()
      const before = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        undefined,
        {
          days,
        }
      )
      yield* before.trigger
      // The next evening, a new worker over the same storage.
      yield* TestClock.setTime(wib("2026-11-13", "17:00:00"))
      const after = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        undefined,
        {
          days,
        }
      )
      yield* after.trigger
      assert.deepStrictEqual(after.walked, [
        "Ajaib 2026-11-13",
        "gaps 2026-11-12",
      ])
      assert.deepStrictEqual(days.days(), ["2026-11-13"])
    })
  )
})
