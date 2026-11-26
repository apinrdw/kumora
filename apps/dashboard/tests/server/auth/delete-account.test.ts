import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect } from "effect"

import type { Mail } from "@/server/auth/mailer"

import {
  ADMIN_EMAIL,
  DASHBOARD_URL,
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

// A verified account signed in on two browsers: the cookies of each.
const twoBrowsers = (mails: ReadonlyArray<Mail>, email = EMAIL) =>
  Effect.gen(function* () {
    yield* signUp(email, PASSWORD)
    const first = cookiesFrom(yield* send(linkIn(mails.at(-1))))
    const second = cookiesFrom(
      yield* post("/sign-in/email", { email, password: PASSWORD })
    )
    return { first, second }
  })

const requestLink = (cookie: string) => post("/delete-user", {}, { cookie })

// The token of the /delete-account link in a mail.
const tokenIn = (mail: Mail | undefined) =>
  mail?.text.match(/\/delete-account\?token=(\S+)/)?.[1] ?? ""

// What /delete-account does with the token once the account says yes.
const deleteWith = (cookie: string, token: string) =>
  send(`/delete-user/callback?token=${token}`, { headers: { cookie } })

const signIn = (password: string) =>
  post("/sign-in/email", { email: EMAIL, password }).pipe(
    Effect.map((response) => response.status)
  )

describe("delete account", () => {
  it.effect("mails the account a link to the delete page", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first } = yield* twoBrowsers(mails)
      const sent = mails.length
      const response = yield* requestLink(first)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(mails.length, sent + 1)
      assert.strictEqual(mails.at(-1)?.to, EMAIL)
      assert.match(
        mails.at(-1)?.text ?? "",
        new RegExp(`^${DASHBOARD_URL}/delete-account\\?token=\\w+$`, "m")
      )
      assert.isNotNull(yield* sessionOf(first))
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "by the link removes the account, its sessions and its sign-in methods",
    () => {
      const { layer, mails, database } = seam()
      return Effect.gen(function* () {
        const { first, second } = yield* twoBrowsers(mails)
        const { id } = database
          .prepare(`select id from "user" where email = ?`)
          .get(EMAIL) as { id: string }
        yield* requestLink(first)
        const response = yield* deleteWith(first, tokenIn(mails.at(-1)))
        assert.strictEqual(response.status, 200)

        assert.isNull(yield* sessionOf(first))
        assert.isNull(yield* sessionOf(second))
        assert.strictEqual(yield* signIn(PASSWORD), 401)
        const methods = database
          .prepare(`select count(*) as n from "account" where userId = ?`)
          .get(id) as { n: number }
        assert.strictEqual(methods.n, 0)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("lets the same email sign up again", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first } = yield* twoBrowsers(mails)
      yield* requestLink(first)
      yield* deleteWith(first, tokenIn(mails.at(-1)))

      const sent = mails.length
      const again = yield* signUp(EMAIL, "battery staple")
      assert.strictEqual(mails.length, sent + 1)
      assert.strictEqual(mails.at(-1)?.to, EMAIL)
      const session = yield* sessionOf(cookiesFrom(again))
      assert.strictEqual(session?.user.email, EMAIL)
      assert.isFalse(session?.user.emailVerified)
      assert.strictEqual(yield* signIn(PASSWORD), 401)
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    [59, 200],
    [61, 404],
  ] as const)(
    "by a link opened after %s minutes answers %s",
    ([minutes, status]) => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const { first } = yield* twoBrowsers(mails)
        yield* requestLink(first)
        vi.useFakeTimers({ toFake: ["Date"] })
        vi.setSystemTime(Date.now() + minutes * 60 * 1000)
        const response = yield* deleteWith(first, tokenIn(mails.at(-1)))
        assert.strictEqual(response.status, status)
      }).pipe(
        Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
        Effect.provide(layer)
      )
    }
  )

  it.effect("refuses a link opened signed out, and keeps the account", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first } = yield* twoBrowsers(mails)
      yield* requestLink(first)
      const response = yield* deleteWith("", tokenIn(mails.at(-1)))
      assert.strictEqual(response.status, 401)
      assert.isNotNull(yield* sessionOf(first))
    }).pipe(Effect.provide(layer))
  })

  it.effect("is refused to a config admin, with 403 and no mail", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { first } = yield* twoBrowsers(mails, ADMIN_EMAIL)
      assert.strictEqual((yield* sessionOf(first))?.user.role, "admin")
      const sent = mails.length
      const response = yield* requestLink(first)
      assert.strictEqual(response.status, 403)
      assert.strictEqual(mails.length, sent)
    }).pipe(Effect.provide(layer))
  })
})
