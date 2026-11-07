import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect } from "effect"

import {
  ADMIN_EMAIL,
  BASE_URL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
  sessionOf,
  signUp,
} from "./seam.ts"

describe("sign-up", () => {
  it.effect("mails a verification link to the new account", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const response = yield* signUp("ayu@example.com")
      assert.strictEqual(response.status, 200)
      assert.strictEqual(mails.length, 1)
      assert.strictEqual(mails[0]?.to, "ayu@example.com")
      assert.include(mails[0]?.text, `${BASE_URL}/api/auth/verify-email?token=`)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers a taken email like a new one, and mails nothing", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      const again = yield* signUp("ayu@example.com", "another passphrase")
      assert.strictEqual(again.status, 200)
      assert.notInclude(yield* Effect.promise(() => again.text()), "exists")
      assert.strictEqual(mails.length, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    ["seven", 400, "1234567"],
    ["eight", 200, "12345678"],
  ] as const)(
    "with a %s-character password answers %s",
    ([, status, password]) => {
      const { layer } = seam()
      return Effect.gen(function* () {
        const response = yield* signUp("ayu@example.com", password)
        assert.strictEqual(response.status, status)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("starts a 30-day session with a 5-minute cookie cache", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const response = yield* signUp("ayu@example.com")
      const maxAge = (name: string) =>
        response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith(`better-auth.${name}=`))
          ?.match(/Max-Age=(\d+)/)?.[1]
      assert.strictEqual(maxAge("session_token"), String(30 * 24 * 60 * 60))
      assert.strictEqual(maxAge("session_data"), "300")
    }).pipe(Effect.provide(layer))
  })

  it.effect("signs the new account in, unverified", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const response = yield* signUp("ayu@example.com")
      const session = yield* sessionOf(cookiesFrom(response))
      assert.strictEqual(session?.user.email, "ayu@example.com")
      assert.isFalse(session?.user.emailVerified)
    }).pipe(Effect.provide(layer))
  })
})

describe("the verification link", () => {
  it.effect("verifies the account and returns to the callback URL", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      const response = yield* send(linkIn(mails[0]))
      assert.strictEqual(response.status, 302)
      assert.strictEqual(response.headers.get("location"), "/")
      const session = yield* sessionOf(cookiesFrom(response))
      assert.isTrue(session?.user.emailVerified)
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    [23, "/"],
    [25, "/?error=TOKEN_EXPIRED"],
  ] as const)("opened after %s hours redirects to %s", ([hours, location]) => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.now() + hours * 60 * 60 * 1000)
      const response = yield* send(linkIn(mails[0]))
      assert.strictEqual(response.headers.get("location"), location)
    }).pipe(
      Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
      Effect.provide(layer)
    )
  })
})

describe("the admin grant", () => {
  it.effect("leaves a new account on the admin list a member", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const response = yield* signUp(ADMIN_EMAIL)
      const session = yield* sessionOf(cookiesFrom(response))
      assert.strictEqual(session?.user.role, "member")
    }).pipe(Effect.provide(layer))
  })

  it.effect("makes an account on the admin list admin once verified", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp(ADMIN_EMAIL.toUpperCase())
      const response = yield* send(linkIn(mails[0]))
      const session = yield* sessionOf(cookiesFrom(response))
      assert.strictEqual(session?.user.role, "admin")
    }).pipe(Effect.provide(layer))
  })

  it.effect("leaves a verified account off the list a member", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      const response = yield* send(linkIn(mails[0]))
      const session = yield* sessionOf(cookiesFrom(response))
      assert.strictEqual(session?.user.role, "member")
    }).pipe(Effect.provide(layer))
  })
})

describe("a callback that dies", () => {
  it.effect("answers Better Auth's 500 without the cause", () => {
    const { layer } = seam({
      send: () => Effect.die(new Error("binding down")),
    })
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      const response = yield* post("/send-verification-email", {
        email: "ayu@example.com",
      })
      assert.strictEqual(response.status, 500)
      assert.notInclude(
        yield* Effect.promise(() => response.text()),
        "binding down"
      )
    }).pipe(Effect.provide(layer))
  })
})
