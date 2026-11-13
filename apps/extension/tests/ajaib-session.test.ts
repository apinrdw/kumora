import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import {
  PIN_VALIDATE_URL,
  ajaibAccountId,
  makeAjaibSession,
  pinOutcome,
  type SignIn,
} from "../src/worker/ajaib-session.ts"
import { AjaibAccountId } from "../src/worker/ajaib.ts"
import type { Answer, TabRequest } from "../src/worker/broker.ts"

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
    },
    store: {
      pin: Effect.sync(() => Option.fromNullishOr(pin)),
      wipePin: Effect.sync(() => {
        pin = undefined
      }),
      signIn: Effect.sync(() => signIn),
      setSignIn: (next) =>
        Effect.sync(() => {
          signIn = next
        }),
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
})
