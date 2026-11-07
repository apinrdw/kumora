import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Mail } from "@/server/auth/mailer"

import {
  cookiesFrom,
  linkIn,
  post,
  send,
  seam,
  sessionOf,
  signUp,
} from "./seam.ts"

const EMAIL = "ayu@example.com"
const PASSWORD = "correct horse"

const postAs = (cookie: string, path: string, body: unknown = {}) =>
  post(path, body, { cookie })

const json = <A>(response: Response) =>
  Effect.promise(() => response.json() as Promise<A>)

// A verified account signed in on two browsers: the cookies of each.
const twoBrowsers = (mails: ReadonlyArray<Mail>) =>
  Effect.gen(function* () {
    yield* signUp(EMAIL, PASSWORD)
    const first = cookiesFrom(yield* send(linkIn(mails.at(-1))))
    const second = cookiesFrom(
      yield* post("/sign-in/email", { email: EMAIL, password: PASSWORD })
    )
    return { first, second }
  })

const signIn = (password: string) =>
  post("/sign-in/email", { email: EMAIL, password }).pipe(
    Effect.map((response) => response.status)
  )

describe("own-account routes", () => {
  it.effect(
    "refuse an unverified account through the access policy, with 401",
    () => {
      const { layer } = seam()
      return Effect.gen(function* () {
        const cookie = cookiesFrom(yield* signUp(EMAIL))
        const response = yield* postAs(cookie, "/update-user", {
          name: "Ayu Lestari",
        })
        assert.strictEqual(response.status, 401)
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("the display name", () => {
  it.effect("is changed by a verified account", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first } = yield* twoBrowsers(mails)
      const response = yield* postAs(first, "/update-user", {
        name: "Ayu Lestari",
      })
      assert.strictEqual(response.status, 200)
      const session = yield* sessionOf(first)
      assert.strictEqual(session?.user.name, "Ayu Lestari")
    }).pipe(Effect.provide(layer))
  })
})

describe("change password", () => {
  it.effect("refuses a wrong current password and keeps the old one", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first } = yield* twoBrowsers(mails)
      const response = yield* postAs(first, "/change-password", {
        currentPassword: "not my password",
        newPassword: "battery staple",
        revokeOtherSessions: true,
      })
      assert.strictEqual(response.status, 400)
      assert.strictEqual(yield* signIn(PASSWORD), 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "with the current password sets the new one and ends the other sessions",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const { first, second } = yield* twoBrowsers(mails)
        const response = yield* postAs(first, "/change-password", {
          currentPassword: PASSWORD,
          newPassword: "battery staple",
          revokeOtherSessions: true,
        })
        assert.strictEqual(response.status, 200)
        assert.isNull(yield* sessionOf(second))
        assert.isNotNull(yield* sessionOf(cookiesFrom(response)))
        assert.strictEqual(yield* signIn(PASSWORD), 401)
        assert.strictEqual(yield* signIn("battery staple"), 200)
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("ending sessions", () => {
  it.effect("ends one session, and only that one", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first, second } = yield* twoBrowsers(mails)
      const current = yield* json<{ session: { token: string } }>(
        yield* send("/get-session", { headers: { cookie: second } })
      )
      const response = yield* postAs(first, "/revoke-session", {
        token: current.session.token,
      })
      assert.strictEqual(response.status, 200)
      assert.isNull(yield* sessionOf(second))
      assert.isNotNull(yield* sessionOf(first))
    }).pipe(Effect.provide(layer))
  })

  it.effect("ends every other session and keeps this one", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first, second } = yield* twoBrowsers(mails)
      const response = yield* postAs(first, "/revoke-other-sessions")
      assert.strictEqual(response.status, 200)
      assert.isNull(yield* sessionOf(second))
      assert.isNotNull(yield* sessionOf(first))
    }).pipe(Effect.provide(layer))
  })
})
