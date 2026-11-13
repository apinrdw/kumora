import { assert, describe, it } from "@effect/vitest"
import type { Feed } from "@workspace/relay"
import { Clock, Deferred, Effect, Fiber, Option, type Duration } from "effect"
import { TestClock } from "effect/testing"

import { makeAjaibSession, type SignIn } from "../src/worker/ajaib-session.ts"
import type { Answer, TabRequest } from "../src/worker/broker.ts"
import { makePacer, type Priority } from "../src/worker/pacer.ts"

const OK: Answer = { _tag: "answer", id: 0, status: 200, body: "{}" }

// A broker site's tab: each REST call takes `takes`, answers what `answer`
// gives for it, and is kept with the times it started and ended. A call
// still running when the tab goes answers none. `request` gives up on the
// tab's answer after 15 seconds, as the real tab does; `awaitAnswer` waits
// for it.
const fakeSite = (
  options: {
    readonly takes?: Duration.Input
    readonly answer?: (request: TabRequest) => Answer
  } = {}
) => {
  interface Call {
    readonly path: string
    readonly start: number
    end?: number
  }
  const calls: Array<Call> = []
  let gone = Deferred.makeUnsafe<void>()
  const awaitAnswer = (request: TabRequest) =>
    Effect.gen(function* () {
      const call: Call = {
        path: request._tag === "page-fetch" ? request.path : request._tag,
        start: yield* Clock.currentTimeMillis,
      }
      calls.push(call)
      const answered = yield* Effect.raceFirst(
        Effect.as(
          Effect.sleep(options.takes ?? "0 millis"),
          Option.some(options.answer?.(request) ?? OK)
        ),
        Effect.as(Deferred.await(gone), Option.none<Answer>())
      )
      call.end = yield* Clock.currentTimeMillis
      return answered
    })
  return {
    calls,
    awaitAnswer,
    request: (request: TabRequest) =>
      Effect.map(
        Effect.timeoutOption(awaitAnswer(request), "15 seconds"),
        Option.flatten
      ),
    // The tab goes: every call still running answers none.
    detach: Effect.suspend(() => {
      const was = gone
      gone = Deferred.makeUnsafe<void>()
      return Deferred.succeed(was, undefined)
    }),
  }
}

const harness = Effect.fnUntraced(function* (
  feed: Feed,
  site: ReturnType<typeof fakeSite>
) {
  const pacer = yield* makePacer({ feed, tab: site })
  const fiber = yield* Effect.forkChild(pacer.run)
  // A call from a fiber of its own, settled before the clock moves on.
  const submit = (priority: Priority, path: string) =>
    Effect.tap(
      Effect.forkChild(
        pacer.tab(priority).request({ _tag: "page-fetch", path })
      ),
      () => TestClock.adjust("0 millis")
    )
  const submitMany = (priority: Priority, prefix: string, count: number) =>
    Effect.forEach(
      Array.from({ length: count }, (_, at) => `${prefix}${at}`),
      (path) => submit(priority, path),
      { discard: true }
    )
  // The calls that started in [from, to), by path.
  const startedIn = (from: number, to: number) =>
    site.calls
      .filter((call) => call.start >= from && call.start < to)
      .map((call) => call.path)
  // Walk calls without end: `fibers` callers, each calling again as soon as
  // its last call ends, so the pacer always has one waiting.
  const saturate = (fibers: number) =>
    Effect.forEach(
      Array.from({ length: fibers }, (_, at) => at),
      (at) =>
        Effect.andThen(
          Effect.forkChild(
            Effect.forever(
              pacer.tab("walk").request({ _tag: "page-fetch", path: `s${at}` })
            )
          ),
          TestClock.adjust("0 millis")
        ),
      { discard: true }
    )
  return {
    tab: pacer.tab,
    submit,
    submitMany,
    saturate,
    startedIn,
    stop: Fiber.interrupt(fiber),
  }
})

// No 1-second window holds more than `cap` call starts.
const assertCap = (starts: ReadonlyArray<number>, cap: number) => {
  for (const start of starts)
    assert.isAtMost(
      starts.filter((other) => other >= start && other < start + 1000).length,
      cap
    )
}

describe("the pacer", () => {
  it.effect("caps a site at 3 calls a second", () =>
    Effect.gen(function* () {
      const site = fakeSite()
      const pacer = yield* harness("Stockbit", site)
      yield* pacer.submitMany("walk", "w", 30)
      yield* TestClock.adjust("10 seconds")
      assertCap(
        site.calls.map((call) => call.start),
        3
      )
      // And it uses the cap: 3 a second, give or take the first.
      assert.isAtLeast(site.calls.length, 29)
      yield* pacer.stop
    })
  )

  it.effect("starts waiting backfill calls before walk calls", () =>
    Effect.gen(function* () {
      const site = fakeSite()
      const pacer = yield* harness("Stockbit", site)
      yield* pacer.submitMany("walk", "w", 3)
      yield* pacer.submitMany("backfill", "b", 2)
      yield* TestClock.adjust("2 seconds")
      // w0 had the site to itself; then the backfill calls jump the walk's.
      assert.deepStrictEqual(
        site.calls.map((call) => call.path),
        ["w0", "b0", "b1", "w1", "w2"]
      )
      yield* pacer.stop
    })
  )

  it.effect("keeps one Ajaib call in flight", () =>
    Effect.gen(function* () {
      const site = fakeSite({ takes: "2 seconds" })
      const pacer = yield* harness("Ajaib", site)
      yield* pacer.submitMany("walk", "w", 3)
      yield* TestClock.adjust("7 seconds")
      assert.deepStrictEqual(
        site.calls.map((call) => [call.path, call.start, call.end]),
        [
          ["w0", 0, 2000],
          ["w1", 2000, 4000],
          ["w2", 4000, 6000],
        ]
      )
      yield* pacer.stop
    })
  )

  it.effect(
    "keeps Ajaib's slot until the tab answers a call given up, and drops a waiting one",
    () =>
      Effect.gen(function* () {
        const site = fakeSite({ takes: "2 seconds" })
        const pacer = yield* harness("Ajaib", site)
        const first = yield* pacer.submit("walk", "w0")
        const second = yield* pacer.submit("walk", "w1")
        yield* pacer.submit("walk", "w2")
        yield* TestClock.adjust("500 millis")
        yield* Fiber.interrupt(second)
        yield* Fiber.interrupt(first)
        yield* TestClock.adjust("2 seconds")
        assert.deepStrictEqual(
          site.calls.map((call) => [call.path, call.start, call.end]),
          [
            ["w0", 0, 2000],
            ["w2", 2000, undefined],
          ]
        )
        yield* pacer.stop
      })
  )

  it.effect(
    "keeps Ajaib's slot past the caller's 15 seconds until the tab answers",
    () =>
      Effect.gen(function* () {
        const site = fakeSite({ takes: "20 seconds" })
        const pacer = yield* harness("Ajaib", site)
        const first = yield* pacer.submit("walk", "w0")
        yield* pacer.submit("walk", "w1")
        yield* TestClock.adjust("16 seconds")
        assert.deepStrictEqual(yield* Fiber.join(first), Option.none())
        assert.deepStrictEqual(
          site.calls.map((call) => call.path),
          ["w0"]
        )
        yield* TestClock.adjust("5 seconds")
        assert.deepStrictEqual(
          site.calls.map((call) => [call.path, call.start]),
          [
            ["w0", 0],
            ["w1", 20_000],
          ]
        )
        yield* pacer.stop
      })
  )

  it.effect("frees Ajaib's slot when the tab goes", () =>
    Effect.gen(function* () {
      const site = fakeSite({ takes: "10 minutes" })
      const pacer = yield* harness("Ajaib", site)
      const first = yield* pacer.submit("walk", "w0")
      yield* pacer.submit("walk", "w1")
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(first)
      yield* TestClock.adjust("30 seconds")
      yield* site.detach
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(
        site.calls.map((call) => [call.path, call.start, call.end]),
        [
          ["w0", 0, 31_000],
          ["w1", 31_000, undefined],
        ]
      )
      yield* pacer.stop
    })
  )

  it.effect("lets Stockbit's slow calls overlap at the cap", () =>
    Effect.gen(function* () {
      const site = fakeSite({ takes: "2 seconds" })
      const pacer = yield* harness("Stockbit", site)
      yield* pacer.submitMany("walk", "w", 3)
      yield* TestClock.adjust("1 second")
      assert.lengthOf(pacer.startedIn(0, 1000), 3)
      yield* pacer.stop
    })
  )
})

const MINUTE = 60_000

// Throttled answers, each for the site's first call only.
const throttles: ReadonlyArray<readonly [string, Answer]> = [
  ["a 429", { _tag: "answer", id: 0, status: 429, body: "{}" }],
  [
    "a challenge page",
    {
      _tag: "answer",
      id: 0,
      status: 403,
      body: "<!DOCTYPE html><html><title>Just a moment...</title></html>",
    },
  ],
  [
    "cf-mitigated: challenge",
    { _tag: "answer", id: 0, status: 403, body: "", challenge: true },
  ],
]

describe("a throttled site", () => {
  for (const [name, throttled] of throttles)
    it.effect(
      `stops for 5 minutes after ${name}, resumes at half rate, and reaches full rate after 10 clean minutes`,
      () =>
        Effect.gen(function* () {
          const site = fakeSite({
            answer: () => (site.calls.length === 1 ? throttled : OK),
          })
          const pacer = yield* harness("Stockbit", site)
          yield* pacer.saturate(4)
          yield* TestClock.adjust("20 minutes")
          assert.deepStrictEqual(pacer.startedIn(0, 5 * MINUTE), ["s0"])
          const half = pacer.startedIn(5 * MINUTE, 6 * MINUTE).length
          assert.isAtLeast(half, 85)
          assert.isAtMost(half, 90)
          const late = pacer.startedIn(14 * MINUTE, 15 * MINUTE).length
          assert.isAtMost(late, 90)
          const full = pacer.startedIn(15 * MINUTE + 1000, 16 * MINUTE).length
          assert.isAtLeast(full, 170)
          assert.isAtMost(full, 177)
          yield* pacer.stop
        })
    )

  it.effect("starts its 5 minutes again on a throttle at half rate", () =>
    Effect.gen(function* () {
      const at = [1, 100]
      const site = fakeSite({
        answer: () =>
          at.includes(site.calls.length)
            ? { _tag: "answer", id: 0, status: 429, body: "" }
            : OK,
      })
      const pacer = yield* harness("Stockbit", site)
      yield* pacer.saturate(4)
      yield* TestClock.adjust("30 minutes")
      const second = site.calls[99]?.start ?? 0
      assert.deepStrictEqual(
        pacer.startedIn(second + 1, second + 5 * MINUTE),
        []
      )
      const half = pacer.startedIn(second + 5 * MINUTE, second + 6 * MINUTE)
      assert.isAtMost(half.length, 90)
      yield* pacer.stop
    })
  )

  it.effect("says until when a throttle stopped the site", () =>
    Effect.gen(function* () {
      const site = fakeSite({
        answer: () =>
          site.calls.length === 2
            ? { _tag: "answer", id: 0, status: 429, body: "" }
            : OK,
      })
      const stopped: Array<number> = []
      const pacer = yield* makePacer({
        feed: "Ajaib",
        tab: site,
        throttled: (until) =>
          Effect.sync(() => {
            stopped.push(until)
          }),
      })
      yield* Effect.forkChild(pacer.run)
      const walk = pacer.tab("walk")
      yield* walk.request({ _tag: "page-fetch", path: "a" })
      assert.deepStrictEqual(stopped, [])
      yield* TestClock.adjust("1 second")
      yield* walk.request({ _tag: "page-fetch", path: "b" })
      assert.deepStrictEqual(stopped, [1_000 + 5 * MINUTE])
    })
  )
})

describe("Ajaib's PIN sign-in", () => {
  // A PIN entered while the walk's call `w0` runs, its sign-in on the
  // backfill's turn as service-worker.ts gives it.
  const signInDuring = Effect.fnUntraced(function* (
    site: ReturnType<typeof fakeSite>
  ) {
    const pacer = yield* harness("Ajaib", site)
    let signIn: SignIn = { state: "waiting" }
    const session = yield* makeAjaibSession({
      tab: { ...pacer.tab("backfill"), attached: Effect.succeed(true) },
      store: {
        pin: Effect.succeed(Option.some("123456")),
        wipePin: Effect.void,
        signIn: Effect.sync(() => signIn),
        setSignIn: (next) =>
          Effect.sync(() => {
            signIn = next
          }),
      },
    })
    yield* pacer.submit("walk", "w0")
    yield* Effect.forkChild(session.tick)
    yield* TestClock.adjust("0 millis")
    return pacer
  })
  const pinStart = (site: ReturnType<typeof fakeSite>) =>
    site.calls.find((call) => call.path === "page-post")?.start

  it.effect("waits for the Ajaib call in flight", () =>
    Effect.gen(function* () {
      const site = fakeSite({ takes: "2 seconds" })
      const pacer = yield* signInDuring(site)
      yield* TestClock.adjust("1 second")
      assert.isUndefined(pinStart(site))
      yield* TestClock.adjust("2 seconds")
      assert.strictEqual(pinStart(site), 2000)
      yield* pacer.stop
    })
  )

  it.effect("waits out a throttle's 5 minutes", () =>
    Effect.gen(function* () {
      const site = fakeSite({
        answer: (request) =>
          request._tag === "page-fetch" ? { ...OK, status: 429 } : OK,
      })
      const pacer = yield* signInDuring(site)
      yield* TestClock.adjust("4 minutes")
      assert.isUndefined(pinStart(site))
      yield* TestClock.adjust("2 minutes")
      assert.strictEqual(pinStart(site), 5 * 60_000)
      yield* pacer.stop
    })
  )
})
