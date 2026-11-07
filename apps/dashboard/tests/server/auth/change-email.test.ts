import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Mail } from "@/server/auth/mailer"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  send,
  seam,
  sessionOf,
  signUp,
} from "./seam.ts"

const OLD = "ayu@example.com"
const NEW = "ayu.lestari@example.com"

// A verified account signed in: its cookie.
const verified = (mails: ReadonlyArray<Mail>, email = OLD) =>
  Effect.gen(function* () {
    yield* signUp(email)
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  })

const changeEmail = (cookie: string, newEmail: string) =>
  post("/change-email", { newEmail, callbackURL: "/account" }, { cookie })

describe("change email", () => {
  it.effect(
    "mails the old address to confirm, then the new one to verify, and changes only then",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)
        const sent = mails.length

        const response = yield* changeEmail(cookie, NEW)
        assert.strictEqual(response.status, 200)
        assert.strictEqual(mails.length, sent + 1)
        const confirmation = mails.at(-1)
        assert.strictEqual(confirmation?.to, OLD)
        assert.include(confirmation?.text, NEW)

        const confirmed = yield* send(linkIn(confirmation), {
          headers: { cookie },
        })
        assert.strictEqual(confirmed.status, 302)
        assert.strictEqual(confirmed.headers.get("location"), "/account")
        assert.strictEqual((yield* sessionOf(cookie))?.user.email, OLD)
        const verification = mails.at(-1)
        assert.strictEqual(mails.length, sent + 2)
        assert.strictEqual(verification?.to, NEW)
        assert.notInclude(verification?.text, "creating")

        const done = yield* send(linkIn(verification), { headers: { cookie } })
        assert.strictEqual(done.headers.get("location"), "/account")
        const session = yield* sessionOf(cookie)
        assert.strictEqual(session?.user.email, NEW)
        assert.isTrue(session?.user.emailVerified)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("keeps a linked Google account linked", () => {
    const { layer, mails, database } = seam()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)
      const { id } = database
        .prepare(`select id from "user" where email = ?`)
        .get(OLD) as { id: string }
      database
        .prepare(
          `insert into "account" (id, accountId, providerId, userId, createdAt, updatedAt)
           values ('g1', 'google-sub-1', 'google', ?, ?, ?)`
        )
        .run(id, new Date().toISOString(), new Date().toISOString())

      yield* changeEmail(cookie, NEW)
      yield* send(linkIn(mails.at(-1)), { headers: { cookie } })
      yield* send(linkIn(mails.at(-1)), { headers: { cookie } })

      const accounts = yield* send("/list-accounts", { headers: { cookie } })
      const providers = (
        (yield* Effect.promise(() => accounts.json())) as Array<{
          providerId: string
        }>
      ).map((account) => account.providerId)
      assert.sameMembers(providers, ["credential", "google"])
      assert.strictEqual((yield* sessionOf(cookie))?.user.email, NEW)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "to an email on the admin list grants admin once the new address is verified",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const cookie = yield* verified(mails)
        yield* changeEmail(cookie, ADMIN_EMAIL)
        yield* send(linkIn(mails.at(-1)), { headers: { cookie } })
        assert.strictEqual((yield* sessionOf(cookie))?.user.role, "member")

        yield* send(linkIn(mails.at(-1)), { headers: { cookie } })
        const session = yield* sessionOf(cookie)
        assert.strictEqual(session?.user.email, ADMIN_EMAIL)
        assert.strictEqual(session?.user.role, "admin")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("is refused to a config admin, with 403 and no mail", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails, ADMIN_EMAIL)
      const sent = mails.length
      const response = yield* changeEmail(cookie, NEW)
      assert.strictEqual(response.status, 403)
      assert.strictEqual(mails.length, sent)
    }).pipe(Effect.provide(layer))
  })
})
