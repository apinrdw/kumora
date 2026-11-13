import { assert, describe, it } from "@effect/vitest"
import { WibDate, type Feed } from "@workspace/relay"
import { Deferred, Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import {
  makeHistoryWalk,
  type HistoryCatchUpStore,
  type HistoryPosition,
  type HistoryStore,
} from "../../src/worker/broker-codes/history.ts"
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

// A Stockbit walk kept as `<name> <day>`.
const tagged = (
  name: string,
  walked: Array<string>,
  result: (day: WibDate) => Effect.Effect<WalkResult> = () =>
    Effect.succeed({ _tag: "walked" })
) => ({
  feed: "Stockbit" as const,
  walk: (day: WibDate) =>
    Effect.suspend(() => {
      walked.push(`${name} ${day}`)
      return result(day)
    }),
})

// The incomplete-days list as chrome.storage.local keeps it, with the
// newest closed day the last run walked.
const memoryDays = (days: ReadonlyArray<string> = [], lastNewest?: string) => {
  let kept = days.map((day) => WibDate.make(day))
  let newest = Option.map(Option.fromUndefinedOr(lastNewest), WibDate.make)
  return {
    days: () => kept,
    store: {
      load: Effect.sync(() => kept),
      save: (next: ReadonlyArray<WibDate>) =>
        Effect.sync(() => {
          kept = [...next]
        }),
      lastNewest: Effect.sync(() => newest),
      saveLastNewest: (day: WibDate) =>
        Effect.sync(() => {
          newest = Option.some(day)
        }),
    } satisfies IncompleteDaysStore,
  }
}

// The History walk's positions as chrome.storage.local keeps them: an ended
// one, the extra target caught up to it, by default, so a test that isn't
// about History walks none.
const memoryHistory = (
  position: Option.Option<HistoryPosition> = Option.some({
    oldest: WibDate.make("2000-01-03"),
    empty: 15,
    ended: true,
  }),
  caughtUpTo: Option.Option<WibDate> = Option.map(
    position,
    ({ oldest }) => oldest
  )
) => {
  let kept = position
  let caughtUp = caughtUpTo
  return {
    position: () => kept,
    caughtUp: () => caughtUp,
    lose: () => {
      kept = Option.none()
    },
    store: {
      load: Effect.sync(() => kept),
      save: (next: HistoryPosition) =>
        Effect.sync(() => {
          kept = Option.some(next)
        }),
    } satisfies HistoryStore,
    catchUpStore: {
      load: Effect.sync(() => caughtUp),
      save: (oldest: WibDate) =>
        Effect.sync(() => {
          caughtUp = Option.some(oldest)
        }),
    } satisfies HistoryCatchUpStore,
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
    // The extra target's gap walk of an older day, kept as
    // `catch-up gaps <day>`.
    readonly gapsCatchUp?: (day: WibDate) => Effect.Effect<WalkResult>
    readonly history?: ReturnType<typeof memoryHistory>
    // Production's walk of a History day, kept as `history <day>`.
    readonly historyWalk?: (day: WibDate) => Effect.Effect<WalkResult>
    // The extra target's, kept as `catch-up history <day>`.
    readonly historyCatchUp?: (day: WibDate) => Effect.Effect<WalkResult>
  } = {}
) {
  const walked: Array<string> = []
  const progress: Array<BrokerCodesProgress> = []
  // The owner's Pause switch, as chrome.storage.local keeps it.
  let paused = false
  const days = older.days ?? memoryDays()
  const history = older.history ?? memoryHistory()
  const report = (each: BrokerCodesProgress) =>
    Effect.sync(() => {
      progress.push(each)
    })
  const queue = yield* makeRunQueue({
    newestDay: walks(walked),
    incompleteDays: days.store,
    gaps: gapWalk(walked, older.gaps),
    history: yield* makeHistoryWalk({
      walk: tagged("history", walked, older.historyWalk),
      store: history.store,
      incompleteDays: days.store,
      catchUp: tagged("catch-up history", walked, older.historyCatchUp),
      catchUpStore: history.catchUpStore,
      report,
    }),
    catchUp: catchUp(walked),
    gapsCatchUp: tagged("catch-up gaps", walked, older.gapsCatchUp),
    paused: Effect.sync(() => paused),
    report,
  })
  yield* Effect.forkChild(queue.run)
  const settle = TestClock.adjust("0 millis")
  return {
    walked,
    progress,
    days,
    history,
    tick: Effect.andThen(queue.tick, settle),
    trigger: Effect.andThen(queue.trigger, settle),
    // The owner's switch turned on, then off: the worker pauses the queue
    // on the first, and Resume triggers it.
    pause: Effect.andThen(
      Effect.suspend(() => {
        paused = true
        return queue.pause
      }),
      settle
    ),
    resume: Effect.andThen(
      Effect.suspend(() => {
        paused = false
        return queue.trigger
      }),
      settle
    ),
  }
})

describe("the broker codes run queue", () => {
  it.effect(
    "walks the newest closed day on the first tick after 16:35, once",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "16:00:00"))
        const queue = yield* harness((walked) => [fakeWalk("Ajaib", walked)])
        // Streaming hours: nothing runs.
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
          "catch-up gaps 2026-11-12",
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
            Effect.succeed({ _tag: "stopped", cause: "streaming-hours" })
          ),
          fakeWalk("Stockbit", walked),
        ])
        yield* queue.tick
        assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
        assert.deepStrictEqual(queue.progress.at(-1), {
          state: "paused",
          cause: "streaming-hours",
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

  // The options page asks the days again on each new progress, so the
  // extra target's Behind clears once its catch-up ends.
  it.effect("publishes a new progress once the catch-up ends", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const caughtUp = yield* Deferred.make<WalkResult>()
      const queue = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        (walked) => [
          catchUpWalk("Ajaib", walked, () => Deferred.await(caughtUp)),
        ]
      )
      yield* queue.trigger
      assert.deepStrictEqual(queue.walked.at(-1), "catch-up Ajaib 2026-11-12")
      const during = queue.progress.at(-1)
      yield* Deferred.succeed(caughtUp, { _tag: "walked" })
      yield* TestClock.adjust("0 millis")
      assert.deepStrictEqual(queue.progress.at(-1), { state: "idle" })
      assert.notDeepEqual(during, queue.progress.at(-1))
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
    "walks older days' gaps after the new day, oldest first, then the extra target's catch-up of each",
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
          // Each day the run began with, those Production completed too.
          "catch-up gaps 2026-11-06",
          "catch-up gaps 2026-11-10",
          "catch-up gaps 2026-11-11",
        ])
        assert.deepStrictEqual(queue.progress.slice(-2), [
          {
            state: "walking",
            walk: "gaps",
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

  it.effect(
    "a browser closed Monday to Wednesday walks those evenings' days from Stockbit",
    () =>
      Effect.gen(function* () {
        // The last run walked Friday 2026-11-06; the browser opens again on
        // Thursday 2026-11-12's evening.
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          undefined,
          {
            days: memoryDays([], "2026-11-06"),
            gaps: () =>
              Effect.succeed({ _tag: "unserved", reason: "incomplete" }),
          }
        )
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "gaps 2026-11-09",
          "gaps 2026-11-10",
          "gaps 2026-11-11",
          "catch-up gaps 2026-11-09",
          "catch-up gaps 2026-11-10",
          "catch-up gaps 2026-11-11",
        ])
        assert.deepStrictEqual(queue.days.days(), [
          "2026-11-09",
          "2026-11-10",
          "2026-11-11",
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
        "catch-up gaps 2026-11-12",
      ])
      assert.deepStrictEqual(days.days(), ["2026-11-13"])
    })
  )
})

// Days the History walk asks for, as a tape answers them: `traded` days have
// trades, any other weekday answers 200 with no rows.
const tape =
  (traded: ReadonlyArray<string>) =>
  (day: WibDate): Effect.Effect<WalkResult> =>
    Effect.succeed(
      traded.includes(day)
        ? { _tag: "walked" }
        : { _tag: "unserved", reason: "no-rows" }
    )

const unpositioned = () => memoryHistory(Option.none())

// The 15 weekdays from 2026-11-06 back.
const FIFTEEN_BEFORE_NOV_9 = [
  "2026-11-06",
  "2026-11-05",
  "2026-11-04",
  "2026-11-03",
  "2026-11-02",
  "2026-10-30",
  "2026-10-29",
  "2026-10-28",
  "2026-10-27",
  "2026-10-26",
  "2026-10-23",
  "2026-10-22",
  "2026-10-21",
  "2026-10-20",
  "2026-10-19",
]

describe("the broker codes run queue: the History walk", () => {
  it.effect(
    "after the older days' gaps, walks back a weekday at a time from the day before, until 15 empty weekdays in a row",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          (walked) => [catchUpWalk("Stockbit", walked)],
          {
            days: memoryDays(["2026-11-10"]),
            history: unpositioned(),
            historyWalk: tape(["2026-11-11", "2026-11-10", "2026-11-09"]),
          }
        )
        yield* queue.trigger
        const history = [
          "2026-11-11",
          "2026-11-10",
          "2026-11-09",
          ...FIFTEEN_BEFORE_NOV_9,
        ]
        assert.deepStrictEqual(queue.walked.slice(0, 2 + history.length), [
          "Ajaib 2026-11-12",
          "gaps 2026-11-10",
          ...history.map((day) => `history ${day}`),
        ])
        assert.deepStrictEqual(
          queue.history.position(),
          Option.some({
            oldest: WibDate.make("2026-10-19"),
            empty: 15,
            ended: true,
          })
        )
        // Ended for good: the next run walks no History day.
        yield* TestClock.setTime(wib("2026-11-13", "17:00:00"))
        yield* queue.tick
        assert.deepStrictEqual(
          queue.walked
            .slice(2 + history.length)
            .filter((each) => each.startsWith("history ")),
          []
        )
      })
  )

  it.effect(
    "a History day left incomplete joins the incomplete days, and the next run walks its gaps",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        const days = memoryDays()
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          undefined,
          {
            days,
            history: unpositioned(),
            historyWalk: (day) =>
              Effect.succeed(
                day === "2026-11-11"
                  ? { _tag: "unserved", reason: "incomplete" }
                  : { _tag: "unserved", reason: "no-rows" }
              ),
          }
        )
        yield* queue.trigger
        assert.deepStrictEqual(days.days(), ["2026-11-12", "2026-11-11"])
        yield* TestClock.setTime(wib("2026-11-13", "17:00:00"))
        yield* queue.tick
        assert.includeMembers(queue.walked, [
          "gaps 2026-11-11",
          "gaps 2026-11-12",
        ])
      })
  )

  it.effect("a traded day resets the count of empty weekdays", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const queue = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        undefined,
        {
          history: unpositioned(),
          // 14 empty weekdays from 2026-11-10 to 2026-10-22, between two
          // traded days.
          historyWalk: tape(["2026-11-11", "2026-10-21"]),
        }
      )
      yield* queue.trigger
      const history = queue.walked.filter((each) => each.startsWith("history "))
      assert.lengthOf(history, 1 + 14 + 1 + 15)
      assert.strictEqual(history.at(-1), "history 2026-09-30")
      assert.deepStrictEqual(
        queue.history.position(),
        Option.some({
          oldest: WibDate.make("2026-09-30"),
          empty: 15,
          ended: true,
        })
      )
    })
  )

  it.effect(
    "stops in place at 08:40, and carries on from its position after 16:35",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        let stops = 1
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          undefined,
          {
            history: unpositioned(),
            historyWalk: (day) =>
              day === "2026-11-05" && stops-- > 0
                ? Effect.succeed({ _tag: "stopped", cause: "streaming-hours" })
                : tape(["2026-11-11", "2026-11-10"])(day),
          }
        )
        yield* queue.trigger
        assert.deepStrictEqual(queue.walked, [
          "Ajaib 2026-11-12",
          "history 2026-11-11",
          "history 2026-11-10",
          "history 2026-11-09",
          "history 2026-11-06",
          "history 2026-11-05",
        ])
        assert.deepStrictEqual(queue.progress.slice(-2), [
          {
            state: "walking",
            walk: "history",
            day: WibDate.make("2026-11-05"),
            feed: "Stockbit",
          },
          { state: "paused", cause: "streaming-hours" },
        ])
        assert.deepStrictEqual(
          queue.history.position(),
          Option.some({
            oldest: WibDate.make("2026-11-06"),
            empty: 2,
            ended: false,
          })
        )
        // Streaming hours: nothing runs.
        yield* TestClock.setTime(wib("2026-11-13", "09:00:00"))
        yield* queue.trigger
        assert.lengthOf(queue.walked, 6)
        yield* TestClock.setTime(wib("2026-11-13", "16:35:00"))
        yield* queue.tick
        assert.deepStrictEqual(queue.walked.slice(6, 10), [
          "Ajaib 2026-11-13",
          "gaps 2026-11-12",
          "history 2026-11-05",
          "history 2026-11-04",
        ])
        // 2026-11-09 and 2026-11-06 still count: it ends 13 weekdays on.
        assert.strictEqual(
          queue.walked.filter((each) => each.startsWith("history ")).at(-1),
          "history 2026-10-20"
        )
      })
  )

  it.effect(
    "the extra target catches up History days from its own position, back to Production's",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
        let stops = 1
        const queue = yield* harness(
          (walked) => [fakeWalk("Ajaib", walked)],
          (walked) => [catchUpWalk("Stockbit", walked)],
          {
            history: unpositioned(),
            historyWalk: tape(["2026-11-11", "2026-11-10", "2026-11-09"]),
            historyCatchUp: (day) =>
              Effect.succeed(
                day === "2026-11-06" && stops-- > 0
                  ? { _tag: "stopped", cause: "rejected-token" }
                  : { _tag: "walked" }
              ),
          }
        )
        yield* queue.trigger
        const caughtUp = () =>
          queue.walked.filter((each) => each.startsWith("catch-up history "))
        assert.deepStrictEqual(caughtUp(), [
          "catch-up history 2026-11-11",
          "catch-up history 2026-11-10",
          "catch-up history 2026-11-09",
          "catch-up history 2026-11-06",
        ])
        assert.deepStrictEqual(
          queue.history.caughtUp(),
          Option.some(WibDate.make("2026-11-09"))
        )
        assert.deepStrictEqual(queue.progress.at(-1), { state: "idle" })
        yield* queue.trigger
        assert.deepStrictEqual(caughtUp().slice(4), [
          "catch-up history 2026-11-06",
          ...FIFTEEN_BEFORE_NOV_9.slice(1).map(
            (day) => `catch-up history ${day}`
          ),
        ])
        assert.deepStrictEqual(
          queue.history.caughtUp(),
          Option.some(WibDate.make("2026-10-19"))
        )
      })
  )

  it.effect("Pause stops the walk in progress and every run until Resume", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const never = yield* Deferred.make<WalkResult>()
      let first = true
      const queue = yield* harness((walked) => [
        fakeWalk("Ajaib", walked, () => {
          if (!first) return Effect.succeed({ _tag: "walked" })
          first = false
          return Deferred.await(never)
        }),
        fakeWalk("Stockbit", walked),
      ])
      yield* queue.trigger
      assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
      yield* queue.pause
      assert.deepStrictEqual(queue.progress.at(-1), {
        state: "paused",
        cause: "paused",
      })
      // Stockbit's walk never started: the pause ended the run.
      yield* TestClock.adjust("1 hour")
      assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
      // Run now, a tab connecting and the next close run nothing.
      yield* queue.trigger
      yield* TestClock.setTime(wib("2026-11-13", "16:40:00"))
      yield* queue.tick
      assert.deepStrictEqual(queue.walked, ["Ajaib 2026-11-12"])
      assert.deepStrictEqual(queue.progress.at(-1), {
        state: "paused",
        cause: "paused",
      })
      // Resume runs the queue at once.
      yield* queue.resume
      assert.deepStrictEqual(queue.walked.slice(1, 3), [
        "Ajaib 2026-11-13",
        "Stockbit 2026-11-13",
      ])
    })
  )

  it.effect("a worker that starts paused runs nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const queue = yield* harness((walked) => [fakeWalk("Ajaib", walked)])
      yield* queue.pause
      yield* queue.tick
      assert.deepStrictEqual(queue.walked, [])
      assert.deepStrictEqual(queue.progress.at(-1), {
        state: "paused",
        cause: "paused",
      })
    })
  )

  it.effect("a pause during the extra target's catch-up stops it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(wib("2026-11-12", "17:00:00"))
      const never = yield* Deferred.make<WalkResult>()
      const queue = yield* harness(
        (walked) => [fakeWalk("Ajaib", walked)],
        (walked) => [
          catchUpWalk("Ajaib", walked, () => Deferred.await(never)),
          catchUpWalk("Stockbit", walked),
        ]
      )
      yield* queue.trigger
      yield* queue.pause
      yield* TestClock.adjust("1 hour")
      assert.deepStrictEqual(queue.walked, [
        "Ajaib 2026-11-12",
        "catch-up Ajaib 2026-11-12",
      ])
      assert.deepStrictEqual(queue.progress.at(-1), {
        state: "paused",
        cause: "paused",
      })
    })
  )
})
