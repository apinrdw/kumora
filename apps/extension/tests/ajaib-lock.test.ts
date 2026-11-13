import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"

import { makeAjaibLock, type AjaibLock } from "../src/worker/ajaib-lock.ts"
import type { SignIn } from "../src/worker/ajaib-session.ts"
import type { Answer, PageEvent, TabRequest } from "../src/worker/broker.ts"

const typed: Answer = { _tag: "answer", id: 0, status: 200, body: "" }

// An Ajaib tab that answers every request with `reply`, the PIN store and the
// lock state in memory, as chrome.storage.session holds them.
const harness = Effect.fnUntraced(function* (options?: {
  readonly attached?: boolean
  readonly pin?: string
  readonly signIn?: SignIn
  readonly reply?: Answer
}) {
  let attached = options?.attached ?? true
  const requests: Array<TabRequest> = []
  let pin = options?.pin
  let signIn: SignIn = options?.signIn ?? {
    state: "signed-in",
    accessToken: "",
  }
  const locks: Array<AjaibLock> = []
  const lock = yield* makeAjaibLock({
    tab: {
      attached: Effect.sync(() => attached),
      request: (request: TabRequest) =>
        Effect.sync(() => {
          requests.push(request)
          return Option.some(options?.reply ?? typed)
        }),
    },
    pins: {
      latest: Effect.succeed(
        Option.some({
          pin: Effect.sync(() => Option.fromNullishOr(pin)),
          wipePin: Effect.sync(() => {
            pin = undefined
          }),
          signIn: Effect.sync(() => signIn),
          setSignIn: (next) =>
            Effect.sync(() => {
              signIn = next
            }),
        })
      ),
    },
    save: (next) => Effect.sync(() => locks.push(next)),
  })
  yield* Effect.forkChild(lock.run)
  yield* Effect.forkChild(lock.keepAlive)
  const settle = TestClock.adjust("0 millis")
  return {
    lock,
    requests,
    settle,
    locks,
    pin: () => pin,
    detach: Effect.sync(() => {
      attached = false
    }),
    // The page's events, as the tab hands them over.
    page: (event: PageEvent) => Effect.andThen(lock.page(event), settle),
    tick: Effect.andThen(lock.tick, settle),
    // A new entry its sign-in has checked (ajaib-session.ts).
    enter: (entered: string) =>
      Effect.sync(() => {
        pin = entered
        signIn = { state: "signed-in", accessToken: "" }
      }),
    setSignIn: (next: SignIn) =>
      Effect.sync(() => {
        signIn = next
      }),
  }
})

const activities = (requests: ReadonlyArray<TabRequest>) =>
  requests.filter((request) => request._tag === "activity").length
const typings = (requests: ReadonlyArray<TabRequest>) =>
  requests.filter((request) => request._tag === "type-pin")

describe("Ajaib's keep-alive", () => {
  it.effect("moves the mouse in the relayed tab every 10 minutes", () =>
    Effect.gen(function* () {
      const { requests } = yield* harness()
      yield* TestClock.adjust("9 minutes")
      assert.strictEqual(activities(requests), 0)
      yield* TestClock.adjust("1 minute")
      assert.strictEqual(activities(requests), 1)
      yield* TestClock.adjust("8 hours")
      assert.strictEqual(activities(requests), 49)
    })
  )

  it.effect("sends nothing without a relayed Ajaib tab", () =>
    Effect.gen(function* () {
      const { requests, detach } = yield* harness()
      yield* TestClock.adjust("20 minutes")
      assert.strictEqual(activities(requests), 2)
      yield* detach
      yield* TestClock.adjust("2 hours")
      assert.strictEqual(activities(requests), 2)
    })
  )
})

const LOCKED = { _tag: "lock", locked: true } as const
const UNLOCKED = { _tag: "lock", locked: false } as const

describe("Ajaib's PIN lock", () => {
  it.effect("types the stored PIN once, and the page unlocks", () =>
    Effect.gen(function* () {
      const { page, tick, requests, locks, pin } = yield* harness({
        pin: "123456",
      })
      yield* page(LOCKED)
      yield* tick
      yield* page({ _tag: "pin-validated", status: 200 })
      yield* page(UNLOCKED)
      yield* TestClock.adjust("1 minute")
      yield* tick
      assert.deepStrictEqual(typings(requests), [
        { _tag: "type-pin", pin: "123456" },
      ])
      assert.deepStrictEqual(locks, [
        { state: "unlocking" },
        { state: "unlocked" },
      ])
      assert.strictEqual(pin(), "123456")
    })
  )

  it.effect("types it again on a later lock", () =>
    Effect.gen(function* () {
      const { page, requests } = yield* harness({ pin: "123456" })
      yield* page(LOCKED)
      yield* page(UNLOCKED)
      yield* page(LOCKED)
      assert.lengthOf(typings(requests), 2)
    })
  )

  it.effect(
    "a refused PIN is wiped and never typed again; only a new entry is",
    () =>
      Effect.gen(function* () {
        const { page, tick, requests, locks, pin, enter } = yield* harness({
          pin: "111111",
        })
        yield* page(LOCKED)
        yield* page({ _tag: "pin-validated", status: 400 })
        assert.strictEqual(pin(), undefined)
        for (let at = 0; at < 5; at++) {
          yield* page(LOCKED)
          yield* tick
        }
        assert.lengthOf(typings(requests), 1)
        assert.deepStrictEqual(locks.at(-1), {
          state: "locked",
          reason: "refused",
        })
        yield* enter("222222")
        yield* tick
        yield* tick
        assert.deepStrictEqual(typings(requests).at(-1), {
          _tag: "type-pin",
          pin: "222222",
        })
        assert.lengthOf(typings(requests), 2)
      })
  )

  it.effect("the lock screen still showing 10 s later is a refusal", () =>
    Effect.gen(function* () {
      const { page, requests, locks, pin } = yield* harness({ pin: "111111" })
      yield* page(LOCKED)
      yield* page({ _tag: "pin-validated", status: 200 })
      yield* TestClock.adjust("9 seconds")
      assert.strictEqual(pin(), "111111")
      yield* TestClock.adjust("1 second")
      assert.strictEqual(pin(), undefined)
      assert.deepStrictEqual(locks.at(-1), {
        state: "locked",
        reason: "refused",
      })
      yield* page(LOCKED)
      assert.lengthOf(typings(requests), 1)
    })
  )

  it.effect("a lock without a PIN records the cause", () =>
    Effect.gen(function* () {
      const { page, tick, requests, locks } = yield* harness()
      yield* page(LOCKED)
      yield* tick
      assert.lengthOf(typings(requests), 0)
      assert.deepStrictEqual(locks, [{ state: "locked", reason: "no-pin" }])
      yield* page(UNLOCKED)
      assert.deepStrictEqual(locks.at(-1), { state: "unlocked" })
    })
  )

  it.effect(
    "a PIN its sign-in has not checked yet is not typed until it has",
    () =>
      Effect.gen(function* () {
        const { page, tick, requests, setSignIn } = yield* harness({
          pin: "123456",
          signIn: { state: "waiting" },
        })
        yield* page(LOCKED)
        yield* tick
        assert.lengthOf(typings(requests), 0)
        yield* setSignIn({ state: "signed-in", accessToken: "" })
        yield* tick
        assert.lengthOf(typings(requests), 1)
      })
  )

  it.effect("a PIN whose sign-in did not succeed is not typed", () =>
    Effect.gen(function* () {
      for (const state of [
        "none",
        "wrong-pin",
        "needs-2fa",
        "failed",
      ] as const) {
        const { page, tick, requests, locks } = yield* harness({
          pin: "123456",
          signIn: { state },
        })
        yield* page(LOCKED)
        yield* tick
        assert.lengthOf(typings(requests), 0)
        assert.deepStrictEqual(locks, [{ state: "locked", reason: "no-pin" }])
      }
    })
  )

  it.effect(
    "a lock screen that flickers once the PIN is typed does not get it again",
    () =>
      Effect.gen(function* () {
        const { page, tick, requests, locks, pin } = yield* harness({
          pin: "111111",
        })
        yield* page(LOCKED)
        yield* page(UNLOCKED)
        yield* page(LOCKED)
        assert.lengthOf(typings(requests), 1)
        yield* TestClock.adjust("10 seconds")
        assert.strictEqual(pin(), undefined)
        assert.deepStrictEqual(locks.at(-1), {
          state: "locked",
          reason: "refused",
        })
        yield* page(LOCKED)
        yield* tick
        assert.lengthOf(typings(requests), 1)
      })
  )

  it.effect(
    "a lock screen the tab can't find types nothing, so it is tried again",
    () =>
      Effect.gen(function* () {
        const { page, tick, requests, locks, pin } = yield* harness({
          pin: "123456",
          reply: { _tag: "answer", id: 0, status: 404, body: "" },
        })
        yield* page(LOCKED)
        assert.deepStrictEqual(locks.at(-1), {
          state: "locked",
          reason: "not-typed",
        })
        assert.strictEqual(pin(), "123456")
        yield* tick
        assert.lengthOf(typings(requests), 2)
      })
  )
})

describe("Ajaib's lock after a worker restart", () => {
  it.effect(
    "saves the first unlocked report, over a lock left in session storage",
    () =>
      Effect.gen(function* () {
        const { page, locks } = yield* harness()
        yield* page(UNLOCKED)
        assert.deepStrictEqual(locks, [{ state: "unlocked" }])
      })
  )
})
