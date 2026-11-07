import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { Mail } from "@/server/auth/mailer"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
  sessionOf,
} from "./seam.ts"

const MEMBER = "ayu@example.com"
// On the seam's ADMIN_EMAILS, so it is an admin once verified.
const OTHER_ADMIN = "other@example.com"
const PASSWORD = "correct horse"
const HOUR = 60 * 60 * 1000

const json = <A>(response: Response) =>
  Effect.promise(() => response.json() as Promise<A>)

// Signs up and opens the verification link. Returns the account's id and the
// cookies of the verified session.
const verified = (mails: ReadonlyArray<Mail>) =>
  Effect.fnUntraced(function* (email: string) {
    const created = yield* json<{ user: { id: string } }>(
      yield* post("/sign-up/email", {
        email,
        password: PASSWORD,
        name: email.split("@")[0],
        callbackURL: "/",
      })
    )
    const cookie = cookiesFrom(yield* send(linkIn(mails.at(-1))))
    return { id: created.user.id, cookie }
  })

// The Cookie header after a response: a cookie set twice keeps its last
// value, and a cookie the response clears is dropped.
const cookiesAfter = (cookie: string, response: Response) => {
  const jar = new Map(
    cookie
      .split("; ")
      .filter((pair) => pair !== "")
      .map((pair) => pair.split("=", 2) as [string, string])
  )
  for (const set of response.headers.getSetCookie()) {
    const pair = set.split(";")[0] ?? ""
    const at = pair.indexOf("=")
    const name = pair.slice(0, at)
    const value = pair.slice(at + 1)
    if (value === "" || /max-age=0/i.test(set)) jar.delete(name)
    else jar.set(name, value)
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
}

const impersonate = (cookie: string, userId: string) =>
  post("/admin/impersonate-user", { userId }, { cookie })

// An admin and a verified member, and the admin's cookies once it views as
// the member.
const viewingAsMember = (mails: ReadonlyArray<Mail>) =>
  Effect.gen(function* () {
    const admin = yield* verified(mails)(ADMIN_EMAIL)
    const member = yield* verified(mails)(MEMBER)
    const response = yield* impersonate(admin.cookie, member.id)
    assert.strictEqual(response.status, 200)
    return {
      admin,
      member,
      viewing: cookiesAfter(admin.cookie, response),
    }
  })

describe("impersonation targets", () => {
  it.effect(
    "an admin views as a member, in a session that lasts at most 1 h",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const { member, viewing } = yield* viewingAsMember(mails)
        const current = yield* json<{
          user: { id: string }
          session: { impersonatedBy: string | null; expiresAt: string }
        }>(
          yield* send("/get-session?disableCookieCache=true", {
            headers: { cookie: viewing },
          })
        )
        assert.strictEqual(current.user.id, member.id)
        assert.isNotNull(current.session.impersonatedBy)
        assert.isAtMost(
          Date.parse(current.session.expiresAt),
          Date.now() + HOUR
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("refuses another admin, with 403", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL)
      const other = yield* verified(mails)(OTHER_ADMIN)
      const response = yield* impersonate(admin.cookie, other.id)
      assert.strictEqual(response.status, 403)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses the admin itself, with 403", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL)
      const response = yield* impersonate(admin.cookie, admin.id)
      assert.strictEqual(response.status, 403)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses a suspended member, with 403", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL)
      const member = yield* verified(mails)(MEMBER)
      const banned = yield* post(
        "/admin/ban-user",
        { userId: member.id },
        { cookie: admin.cookie }
      )
      assert.strictEqual(banned.status, 200)
      const response = yield* impersonate(admin.cookie, member.id)
      assert.strictEqual(response.status, 403)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers a member with 404, as if there were no such route", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const member = yield* verified(mails)(MEMBER)
      const other = yield* verified(mails)("budi@example.com")
      const response = yield* impersonate(member.cookie, other.id)
      assert.strictEqual(response.status, 404)
      assert.strictEqual((yield* sessionOf(member.cookie))?.user.email, MEMBER)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers an account that doesn't exist with 404", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL)
      const response = yield* impersonate(admin.cookie, "no-such-account")
      assert.strictEqual(response.status, 404)
    }).pipe(Effect.provide(layer))
  })
})

describe("while impersonating", () => {
  it.effect.each([
    ["/update-user", { name: "Someone Else" }],
    [
      "/change-password",
      {
        currentPassword: PASSWORD,
        newPassword: "battery staple",
        revokeOtherSessions: true,
      },
    ],
    ["/change-email", { newEmail: "elsewhere@example.com" }],
    ["/delete-user", {}],
    ["/revoke-session", { token: "any" }],
    ["/revoke-sessions", {}],
    ["/revoke-other-sessions", {}],
  ] as const)("%s is refused with 403", ([path, body]) => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { viewing } = yield* viewingAsMember(mails)
      const response = yield* post(path, body, { cookie: viewing })
      assert.strictEqual(response.status, 403)
      // The impersonation session itself is untouched.
      assert.strictEqual((yield* sessionOf(viewing))?.user.email, MEMBER)
    }).pipe(Effect.provide(layer))
  })

  it.effect("changes nothing about the member", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { member, viewing } = yield* viewingAsMember(mails)
      yield* post("/update-user", { name: "Someone Else" }, { cookie: viewing })
      yield* post("/revoke-sessions", {}, { cookie: viewing })
      const own = yield* sessionOf(member.cookie)
      assert.strictEqual(own?.user.name, "ayu")
    }).pipe(Effect.provide(layer))
  })

  it.effect("Stop returns to the admin's own session", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const { viewing } = yield* viewingAsMember(mails)
      const response = yield* post(
        "/admin/stop-impersonating",
        {},
        {
          cookie: viewing,
        }
      )
      assert.strictEqual(response.status, 200)
      const back = cookiesAfter(viewing, response)
      assert.strictEqual((yield* sessionOf(back))?.user.email, ADMIN_EMAIL)
      // The impersonation session is gone.
      assert.isNull(yield* sessionOf(viewing))
    }).pipe(Effect.provide(layer))
  })
})
