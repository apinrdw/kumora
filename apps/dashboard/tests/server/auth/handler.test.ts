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
import type { Mail } from "@/server/auth/mailer"

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

  it.effect("makes it a config admin, which can't change its email", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp(ADMIN_EMAIL)
      const cookie = cookiesFrom(yield* send(linkIn(mails[0])))
      const response = yield* post(
        "/change-email",
        { newEmail: "elsewhere@example.com" },
        { cookie }
      )
      assert.strictEqual(response.status, 403)
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

describe("password reset", () => {
  const requestReset = (email: string) =>
    post("/request-password-reset", {
      email,
      redirectTo: "/reset-password?redirect=%2Fmarket-live",
    })

  it.effect("mails a reset link that opens the set-password page", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      const response = yield* requestReset("ayu@example.com")
      assert.strictEqual(response.status, 200)
      const mail = mails[1]
      assert.strictEqual(mail?.to, "ayu@example.com")
      assert.strictEqual(mail?.subject, "Reset your KUMORA password")
      const link = yield* send(linkIn(mail))
      assert.match(
        link.headers.get("location") ?? "",
        /^http:\/\/localhost:3001\/reset-password\?redirect=%2Fmarket-live&token=\w+$/
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "answers an unknown email like a known one, and mails nothing",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        yield* signUp("ayu@example.com")
        const known = yield* requestReset("ayu@example.com")
        const unknown = yield* requestReset("nobody@example.com")
        assert.strictEqual(unknown.status, known.status)
        assert.strictEqual(
          yield* Effect.promise(() => unknown.text()),
          yield* Effect.promise(() => known.text())
        )
        assert.deepStrictEqual(
          mails.map((mail) => mail.to),
          ["ayu@example.com", "ayu@example.com"]
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect.each([
    [59, "/reset-password?redirect=%2Fmarket-live&token="],
    [61, "/reset-password?redirect=%2Fmarket-live&error=INVALID_TOKEN"],
  ] as const)("opened after %s minutes goes to %s", ([minutes, location]) => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      yield* requestReset("ayu@example.com")
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.now() + minutes * 60 * 1000)
      const response = yield* send(linkIn(mails[1]))
      assert.include(response.headers.get("location"), `${BASE_URL}${location}`)
    }).pipe(
      Effect.ensuring(Effect.sync(() => vi.useRealTimers())),
      Effect.provide(layer)
    )
  })

  it.effect("ends every session and lets the new password sign in", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const other = cookiesFrom(yield* signUp("ayu@example.com"))
      yield* requestReset("ayu@example.com")
      const reset = yield* resetWith(mails[1], "a new passphrase")
      assert.strictEqual(reset.status, 200)
      assert.isNull(yield* sessionOf(other))
      const oldPassword = yield* signIn("ayu@example.com", "correct horse")
      assert.strictEqual(oldPassword.status, 401)
      const newPassword = yield* signIn("ayu@example.com", "a new passphrase")
      assert.strictEqual(newPassword.status, 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses a token used twice", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      yield* requestReset("ayu@example.com")
      const token = yield* tokenIn(mails[1])
      yield* post("/reset-password", { newPassword: "a new passphrase", token })
      const again = yield* post("/reset-password", {
        newPassword: "a third passphrase",
        token,
      })
      assert.strictEqual(again.status, 400)
      // The set-password page shows "expired" on this code.
      const body = yield* Effect.promise(
        () => again.json() as Promise<{ code: string }>
      )
      assert.strictEqual(body.code, "INVALID_TOKEN")
    }).pipe(Effect.provide(layer))
  })

  it.effect("gives an account with no password its first one", () => {
    const { layer, mails, database } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      // As if Ayu had signed up with Google: a Google account, no password.
      database.exec(
        `update "account" set "providerId" = 'google', "password" = null`
      )
      const before = yield* signIn("ayu@example.com", "correct horse")
      assert.notStrictEqual(before.status, 200)
      yield* requestReset("ayu@example.com")
      yield* resetWith(mails[1], "a first passphrase")
      const after = yield* signIn("ayu@example.com", "a first passphrase")
      assert.strictEqual(after.status, 200)
    }).pipe(Effect.provide(layer))
  })
})

// Someone signed up on an email before its owner: the owner's own sign-up
// gets the same inbox screen, and a mailed link that hands the account over.
describe("a sign-up on an unverified email", () => {
  const EMAIL = "ayu@example.com"
  const SQUATTED = "squatter passphrase"
  const OWN = "owner passphrase"

  it.effect("answers like a new one, and mails a set-password link", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp(EMAIL, SQUATTED)
      const again = yield* signUp(EMAIL, OWN)
      assert.strictEqual(again.status, 200)
      assert.notInclude(yield* Effect.promise(() => again.text()), "exists")
      assert.strictEqual(mails.length, 2)
      assert.strictEqual(mails[1]?.to, EMAIL)
      assert.strictEqual(mails[1]?.subject, "Set your KUMORA password")
      assert.include(mails[1]?.text, `${BASE_URL}/api/auth/reset-password/`)
      assert.notInclude(mails[1]?.text, "/verify-email?")
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "hands the account to whoever sets the password from the link, verified",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const squatter = cookiesFrom(yield* signUp(EMAIL, SQUATTED))
        yield* signUp(EMAIL, OWN)
        assert.strictEqual(mails[1]?.to, EMAIL)
        const set = yield* resetWith(mails[1], OWN)
        assert.strictEqual(set.status, 200)
        assert.isNull(yield* sessionOf(squatter))
        assert.strictEqual((yield* signIn(EMAIL, SQUATTED)).status, 401)
        const owner = yield* signIn(EMAIL, OWN)
        assert.strictEqual(owner.status, 200)
        assert.isTrue(
          (yield* sessionOf(cookiesFrom(owner)))?.user.emailVerified
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("makes an email on the admin list admin only this way", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp(ADMIN_EMAIL, SQUATTED)
      yield* signUp(ADMIN_EMAIL, OWN)
      assert.strictEqual(mails[1]?.to, ADMIN_EMAIL)
      yield* resetWith(mails[1], OWN)
      const owner = yield* signIn(ADMIN_EMAIL, OWN)
      assert.strictEqual(
        (yield* sessionOf(cookiesFrom(owner)))?.user.role,
        "admin"
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "Resend from the inbox screen, with no session, mails a set-password link",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        yield* signUp(EMAIL, SQUATTED)
        yield* signUp(EMAIL, OWN)
        const resent = yield* post("/send-verification-email", {
          email: EMAIL,
          callbackURL: "/",
        })
        assert.strictEqual(resent.status, 200)
        assert.strictEqual(mails.length, 3)
        assert.strictEqual(mails[2]?.subject, "Set your KUMORA password")
        assert.include(mails[2]?.text, `${BASE_URL}/api/auth/reset-password/`)
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "Resend from the account's own session keeps the verify link",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const cookie = cookiesFrom(yield* signUp(EMAIL, SQUATTED))
        yield* post(
          "/send-verification-email",
          { email: EMAIL, callbackURL: "/" },
          { cookie }
        )
        assert.strictEqual(mails.length, 2)
        assert.include(
          mails[1]?.text,
          `${BASE_URL}/api/auth/verify-email?token=`
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("on a verified email still mails nothing", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp(EMAIL, SQUATTED)
      yield* send(linkIn(mails[0]))
      const again = yield* signUp(EMAIL, OWN)
      assert.strictEqual(again.status, 200)
      assert.strictEqual(mails.length, 1)
    }).pipe(Effect.provide(layer))
  })
})

// The token the reset link carries to the set-password page.
const tokenIn = (mail: Mail | undefined) =>
  send(linkIn(mail)).pipe(
    Effect.map((link) =>
      new URL(link.headers.get("location") ?? "").searchParams.get("token")
    )
  )

// Opens the reset link and sets the password, as the set-password page does.
const resetWith = (mail: Mail | undefined, newPassword: string) =>
  tokenIn(mail).pipe(
    Effect.flatMap((token) => post("/reset-password", { newPassword, token }))
  )

const signIn = (email: string, password: string) =>
  post("/sign-in/email", { email, password })

describe("a callback that dies", () => {
  it.effect("answers Better Auth's 500 without the cause", () => {
    const { layer } = seam(() => Effect.die(new Error("binding down")))
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
