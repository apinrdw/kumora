import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { Deferred, Effect, Fiber, Option, Queue } from "effect"

import { makeAjaibLock, type AjaibLock } from "../src/worker/ajaib-lock.ts"

import {
  PIN_VALIDATE_URL,
  ajaibAccountId,
  makeAjaibSession,
  pinOutcome,
  type SignIn,
} from "../src/worker/ajaib-session.ts"
import { AjaibAccountId } from "../src/worker/ajaib.ts"
import type { Answer, TabRequest } from "../src/worker/broker.ts"
import type { PacedTab } from "../src/worker/pacer.ts"
import {
  AjaibPin,
  loadSignIn,
  savePin,
  sessionPinStore,
} from "../src/worker/settings.ts"
import { memorySession } from "./memory-session.ts"

const base64Url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
const jwt = (payload: unknown) =>
  `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url(payload)}.c2ln`

const answer = (status: number, body: unknown): Answer => ({
  _tag: "answer",
  id: 0,
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
})

// Ajaib's answer to a right PIN, as the owner saw it on 2026-11-09.
const approved = (accessToken: string) => ({
  err_code: "EC0000000",
  err_message: "APPROVED/OK",
  result: {
    valid: true,
    access_token: accessToken,
    refresh_token: jwt({ sub: 4999301 }),
    is_pin_6digit: true,
    show_2fa: false,
  },
})

describe("the Ajaib account id", () => {
  it.effect("is the access token's `sub` claim", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* ajaibAccountId(jwt({ sub: 4999301, exp: 1 })),
        Option.some(AjaibAccountId.make(4999301))
      )
      assert.deepStrictEqual(
        yield* ajaibAccountId(jwt({ sub: "4999301" })),
        Option.some(AjaibAccountId.make(4999301))
      )
    })
  )

  it.effect("falls back to `user_id`, then `id`", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* ajaibAccountId(jwt({ user_id: 12 })),
        Option.some(AjaibAccountId.make(12))
      )
      assert.deepStrictEqual(
        yield* ajaibAccountId(jwt({ id: "13" })),
        Option.some(AjaibAccountId.make(13))
      )
    })
  )

  it.effect("is none for a token that names no numeric account", () =>
    Effect.gen(function* () {
      for (const token of [
        "not a token",
        jwt({ sub: "ayu@example.com" }),
        jwt({ exp: 1 }),
        "a.%%%.c",
      ])
        assert.deepStrictEqual(yield* ajaibAccountId(token), Option.none())
    })
  )
})

describe("Ajaib's PIN answer", () => {
  it.effect("a right PIN signs in with the access token", () =>
    Effect.gen(function* () {
      const token = jwt({ sub: 1 })
      assert.deepStrictEqual(yield* pinOutcome(answer(200, approved(token))), {
        state: "signed-in",
        accessToken: token,
      })
    })
  )

  it.effect("a refused PIN, a second factor or a broken answer does not", () =>
    Effect.gen(function* () {
      const refused = {
        ...approved(""),
        err_code: "EC0000012",
        err_message: "INVALID PIN",
        result: { ...approved("").result, valid: false, access_token: "" },
      }
      assert.deepStrictEqual(yield* pinOutcome(answer(200, refused)), {
        state: "wrong-pin",
      })
      const twoFactor = {
        ...approved(jwt({ sub: 1 })),
        result: { ...approved(jwt({ sub: 1 })).result, show_2fa: true },
      }
      assert.deepStrictEqual(yield* pinOutcome(answer(200, twoFactor)), {
        state: "needs-2fa",
      })
      assert.deepStrictEqual(yield* pinOutcome(answer(200, "<html>")), {
        state: "failed",
      })
      assert.deepStrictEqual(yield* pinOutcome(answer(0, "")), {
        state: "failed",
      })
    })
  )
})

// An Ajaib tab that answers the PIN validate with `reply`, and a PIN store in
// memory, as chrome.storage.session holds them.
const harness = Effect.fnUntraced(function* (reply: Answer) {
  const requests: Array<TabRequest> = []
  let pin: string | undefined
  let signIn: SignIn = { state: "none" }
  const session = yield* makeAjaibSession({
    tab: {
      attached: Effect.succeed(true),
      request: (request: TabRequest) =>
        Effect.sync(() => {
          requests.push(request)
          return Option.some(reply)
        }),
    } as PacedTab & { readonly attached: Effect.Effect<boolean> },
    store: {
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
  })
  return {
    session,
    requests,
    // As the options page saves a new entry (settings.ts savePin).
    enter: (entered: string) =>
      Effect.sync(() => {
        pin = entered
        signIn = { state: "waiting" }
      }),
    signIn: () => signIn,
    pin: () => pin,
    restartedMidCall: (entered: string) =>
      Effect.sync(() => {
        pin = entered
        signIn = { state: "signing-in" }
      }),
  }
})

describe("signing in to Ajaib with the PIN", () => {
  it.effect("tries a PIN once, from the tab, and keeps its state", () =>
    Effect.gen(function* () {
      const token = jwt({ sub: 4999301 })
      const { session, requests, enter, signIn, pin } = yield* harness(
        answer(200, approved(token))
      )
      yield* session.tick
      assert.lengthOf(requests, 0)
      yield* enter("123456")
      yield* session.tick
      yield* session.tick
      assert.deepStrictEqual(requests, [
        {
          _tag: "page-post",
          url: PIN_VALIDATE_URL,
          body: '{"pin_code":"123456"}',
        },
      ])
      assert.deepStrictEqual(signIn(), {
        state: "signed-in",
        accessToken: token,
      })
      assert.deepStrictEqual(yield* session.fallbackToken, Option.some(token))
      // Kept for the lock screen (ajaib-lock.ts), yet never sent again.
      assert.strictEqual(pin(), "123456")
    })
  )

  it.effect(
    "never tries a wrong PIN again; only a new entry is tried, once",
    () =>
      Effect.gen(function* () {
        const { session, requests, enter, signIn, pin } = yield* harness(
          answer(200, {
            ...approved(""),
            err_code: "EC0000012",
            result: { ...approved("").result, valid: false },
          })
        )
        yield* enter("111111")
        for (let tick = 0; tick < 5; tick++) yield* session.tick
        assert.lengthOf(requests, 1)
        assert.deepStrictEqual(signIn(), { state: "wrong-pin" })
        assert.strictEqual(pin(), undefined)
        assert.deepStrictEqual(yield* session.fallbackToken, Option.none())
        yield* enter("222222")
        for (let tick = 0; tick < 5; tick++) yield* session.tick
        assert.lengthOf(requests, 2)
      })
  )

  it.effect(
    "a worker restarted during the call never sends the PIN again",
    () =>
      Effect.gen(function* () {
        const { session, requests, restartedMidCall } = yield* harness(
          answer(200, approved(jwt({ sub: 1 })))
        )
        yield* restartedMidCall("123456")
        for (let tick = 0; tick < 5; tick++) yield* session.tick
        assert.lengthOf(requests, 0)
      })
  )

  it.effect("a failed check wipes the PIN too", () =>
    Effect.gen(function* () {
      const { session, enter, signIn, pin } = yield* harness(answer(500, ""))
      yield* enter("123456")
      yield* session.tick
      assert.deepStrictEqual(signIn(), { state: "failed" })
      assert.strictEqual(pin(), undefined)
    })
  )

  it.effect("a second factor asked for wipes the PIN too", () =>
    Effect.gen(function* () {
      const token = jwt({ sub: 1 })
      const { session, enter, signIn, pin } = yield* harness(
        answer(200, {
          ...approved(token),
          result: { ...approved(token).result, show_2fa: true },
        })
      )
      yield* enter("123456")
      yield* session.tick
      assert.deepStrictEqual(signIn(), { state: "needs-2fa" })
      assert.strictEqual(pin(), undefined)
    })
  )
})

// The Ajaib tab answers each PIN check with the next reply offered, and the
// PIN and sign-in live in chrome.storage.session (settings.ts), so the
// options page can save a new entry while a check is in flight.
const storedHarness = Effect.fnUntraced(function* () {
  const storage = memorySession()
  const replies = yield* Queue.unbounded<Answer>()
  const requests: Array<TabRequest> = []
  const tab = {
    attached: Effect.succeed(true),
    request: (request: TabRequest) =>
      Effect.gen(function* () {
        requests.push(request)
        if (request._tag !== "page-post") return Option.some(answer(200, ""))
        return Option.some(yield* Queue.take(replies))
      }),
  } as PacedTab & { readonly attached: Effect.Effect<boolean> }
  const session = yield* makeAjaibSession({ tab, store: sessionPinStore })
  return {
    storage,
    tab,
    session,
    requests,
    reply: (next: Answer) => Effect.asVoid(Queue.offer(replies, next)),
    pinChecks: () =>
      requests.flatMap((request) =>
        request._tag === "page-post" ? [request.body] : []
      ),
  }
})

// Waits for what a forked fiber does over storage answered asynchronously.
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    while (!done()) yield* Effect.sleep("1 millis")
  })

describe("a PIN entered while an earlier one is checked", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.live("is kept, still waiting, and tried once when the earlier fails", () =>
    Effect.gen(function* () {
      const { storage, session, reply, pinChecks } = yield* storedHarness()
      yield* savePin(AjaibPin.make("111111"))
      const first = yield* Effect.forkChild(session.tick)
      yield* until(() => pinChecks().length === 1)
      yield* savePin(AjaibPin.make("222222"))
      yield* reply(answer(500, ""))
      yield* Fiber.join(first)
      assert.deepStrictEqual(yield* loadSignIn, { state: "waiting" })
      assert.include(storage.raw(), "222222")
      yield* reply(answer(200, approved(jwt({ sub: 1 }))))
      yield* session.tick
      yield* session.tick
      assert.deepStrictEqual(pinChecks(), [
        '{"pin_code":"111111"}',
        '{"pin_code":"222222"}',
      ])
      assert.strictEqual((yield* loadSignIn).state, "signed-in")
    })
  )

  it.live("is kept when the lock screen refuses the earlier", () =>
    Effect.gen(function* () {
      const { storage, tab, session, requests, reply, pinChecks } =
        yield* storedHarness()
      const locks: Array<AjaibLock> = []
      const lock = yield* makeAjaibLock({
        tab,
        pins: sessionPinStore,
        save: (next) => Effect.sync(() => locks.push(next)),
      })
      yield* Effect.forkChild(lock.run)
      yield* savePin(AjaibPin.make("111111"))
      yield* reply(answer(200, approved(jwt({ sub: 1 }))))
      yield* session.tick
      yield* lock.page({ _tag: "lock", locked: true })
      yield* until(() => requests.some((each) => each._tag === "type-pin"))
      yield* savePin(AjaibPin.make("222222"))
      yield* lock.page({ _tag: "pin-validated", status: 400 })
      yield* until(() => locks.at(-1)?.state === "locked")
      assert.include(storage.raw(), "222222")
      assert.deepStrictEqual(yield* loadSignIn, { state: "waiting" })
      yield* reply(answer(200, approved(jwt({ sub: 1 }))))
      yield* session.tick
      assert.deepStrictEqual(pinChecks(), [
        '{"pin_code":"111111"}',
        '{"pin_code":"222222"}',
      ])
    })
  )
})

const wrongPin = answer(200, {
  ...approved(""),
  err_code: "EC0000012",
  result: { ...approved("").result, valid: false },
})

// The lock (ajaib-lock.ts) over the same tab and stored PIN. `hold` keeps its
// save of `unlocking` open until `release`, as a slow chrome.storage would.
const lockOver = Effect.fnUntraced(function* (
  stored: Effect.Success<ReturnType<typeof storedHarness>>,
  options?: { readonly hold: boolean }
) {
  const locks: Array<AjaibLock> = []
  const held = yield* Deferred.make<void>()
  const lock = yield* makeAjaibLock({
    tab: stored.tab,
    pins: sessionPinStore,
    save: (next) =>
      Effect.andThen(
        Effect.sync(() => locks.push(next)),
        options?.hold === true && next.state === "unlocking"
          ? Deferred.await(held)
          : Effect.void
      ),
  })
  const run = yield* Effect.forkChild(lock.run)
  return {
    lock,
    locks,
    run,
    release: Effect.asVoid(Deferred.succeed(held, undefined)),
    typed: () =>
      stored.requests.flatMap((request) =>
        request._tag === "type-pin" ? [request.pin] : []
      ),
  }
})

describe("the lock screen and the stored PIN", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Codex review round 12: the lock read the PIN, then awaited storage while
  // sign-in refused and wiped it.
  it.live("a PIN its sign-in refuses as the lock shows is never typed", () =>
    Effect.gen(function* () {
      const stored = yield* storedHarness()
      const { lock, locks, release, typed } = yield* lockOver(stored, {
        hold: true,
      })
      yield* savePin(AjaibPin.make("111111"))
      const check = yield* Effect.forkChild(stored.session.tick)
      yield* until(() => stored.pinChecks().length === 1)
      yield* lock.page({ _tag: "lock", locked: true })
      yield* until(() => locks.length === 1)
      yield* stored.reply(wrongPin)
      yield* Fiber.join(check)
      yield* release
      yield* lock.page({ _tag: "lock", locked: false })
      yield* until(() => locks.at(-1)?.state === "unlocked")
      assert.deepStrictEqual(typed(), [])
      assert.deepStrictEqual(yield* loadSignIn, { state: "wrong-pin" })
    })
  )

  it.live("a PIN replaced as the lock is about to get it is not typed", () =>
    Effect.gen(function* () {
      const stored = yield* storedHarness()
      const { lock, locks, release, typed } = yield* lockOver(stored, {
        hold: true,
      })
      yield* savePin(AjaibPin.make("111111"))
      yield* stored.reply(answer(200, approved(jwt({ sub: 1 }))))
      yield* stored.session.tick
      yield* lock.page({ _tag: "lock", locked: true })
      yield* until(() => locks.length === 1)
      yield* savePin(AjaibPin.make("222222"))
      yield* release
      yield* lock.page({ _tag: "lock", locked: false })
      yield* until(() => locks.at(-1)?.state === "unlocked")
      assert.deepStrictEqual(typed(), [])
    })
  )

  it.live("a worker restarted after typing it never types it again", () =>
    Effect.gen(function* () {
      const stored = yield* storedHarness()
      yield* savePin(AjaibPin.make("111111"))
      yield* stored.reply(answer(200, approved(jwt({ sub: 1 }))))
      yield* stored.session.tick
      const before = yield* lockOver(stored)
      yield* before.lock.page({ _tag: "lock", locked: true })
      yield* until(() => before.typed().length === 1)
      yield* Fiber.interrupt(before.run)
      const after = yield* lockOver(stored)
      yield* after.lock.page({ _tag: "lock", locked: true })
      yield* until(
        () =>
          after.typed().length === 2 || after.locks.at(-1)?.state === "locked"
      )
      assert.deepStrictEqual(after.typed(), ["111111"])
      assert.deepStrictEqual(after.locks.at(-1), {
        state: "locked",
        reason: "refused",
      })
      assert.notInclude(stored.storage.raw(), "111111")
    })
  )

  it.live("two ticks close together send a PIN to its check once", () =>
    Effect.gen(function* () {
      const stored = yield* storedHarness()
      yield* savePin(AjaibPin.make("111111"))
      yield* stored.reply(wrongPin)
      yield* stored.reply(wrongPin)
      yield* Effect.all([stored.session.tick, stored.session.tick], {
        concurrency: 2,
      })
      assert.deepStrictEqual(stored.pinChecks(), ['{"pin_code":"111111"}'])
    })
  )
})
