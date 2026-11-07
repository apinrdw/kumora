import { assert, describe, it } from "@effect/vitest"
import { Unauthorized } from "@workspace/server"
import { Effect } from "effect"

import { accountPage } from "@/server/auth/account-page"

import { cookiesFrom, linkIn, post, seam, send, signUp } from "./seam.ts"

const EMAIL = "ayu@example.com"
const PASSWORD = "correct horse"
const FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"

const headers = (cookie?: string) =>
  new Headers(cookie === undefined ? {} : { cookie })

describe("accountPage", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(accountPage(headers(), "/account"))
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/sign-in?redirect=%2Faccount" })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "shows the account, its sign-in methods and its sessions, this one marked",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        yield* signUp(EMAIL, PASSWORD)
        const verified = cookiesFrom(yield* send(linkIn(mails[0])))
        yield* post(
          "/sign-in/email",
          { email: EMAIL, password: PASSWORD },
          { "user-agent": FIREFOX }
        )
        const page = yield* accountPage(headers(verified), "/account")
        assert.strictEqual(page.email, EMAIL)
        assert.strictEqual(page.name, "Ayu")
        assert.strictEqual(page.role, "member")
        assert.deepStrictEqual(page.signInMethods, ["password"])
        assert.deepStrictEqual(page.allowed, {
          "own.update-profile": true,
          "own.change-password": true,
          "own.end-sessions": true,
          "own.change-email": true,
          "own.delete": true,
        })
        // Sign-up, verification and the Firefox sign-in each began one.
        assert.strictEqual(page.sessions.length, 3)
        assert.deepStrictEqual(
          page.sessions.map((session) => session.current),
          [true, false, false]
        )
        assert.isTrue(
          page.sessions.some((session) => session.device === "Firefox on Linux")
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("sends a session ended elsewhere to sign-in at once", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      yield* signUp(EMAIL, PASSWORD)
      const verified = cookiesFrom(yield* send(linkIn(mails[0])))
      const other = cookiesFrom(
        yield* post("/sign-in/email", { email: EMAIL, password: PASSWORD })
      )
      // Its cookies still cache the session for 5 minutes.
      yield* post("/revoke-other-sessions", {}, { cookie: verified })
      const error = yield* Effect.flip(accountPage(headers(other), "/account"))
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/sign-in?redirect=%2Faccount" })
      )
    }).pipe(Effect.provide(layer))
  })
})
