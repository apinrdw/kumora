import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Layer } from "effect"
import { DatabaseSync } from "node:sqlite"

import { Auth } from "@/server/auth/auth"
import { Mailer, type Mail } from "@/server/auth/mailer"

import { replayMigrations } from "../../../scripts/auth-schema.ts"

const BASE_URL = "http://localhost:3001"

// Seam 3 of spec apinrdw/kumora#80: the real Better Auth config over SQLite
// with the checked-in migrations, driven through its HTTP handler.
function seam(send?: (mail: Mail) => Effect.Effect<void>) {
  const database = new DatabaseSync(":memory:")
  replayMigrations(database)
  const mails: Array<Mail> = []
  const mailer = Layer.succeed(Mailer, {
    send: send ?? ((mail) => Effect.sync(() => void mails.push(mail))),
  })
  const layer = Auth.make({
    database,
    baseURL: BASE_URL,
    secret: "handler-test-secret-0123456789abcdef0123456789",
    validateSchema: true,
  }).pipe(Layer.provide(mailer))
  return { layer, mails }
}

const send = Effect.fnUntraced(function* (path: string, init?: RequestInit) {
  const auth = yield* Auth
  return yield* auth.handler(new Request(`${BASE_URL}/api/auth${path}`, init))
})

const post = (path: string, body: unknown) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const signUp = (email: string, password = "correct horse") =>
  post("/sign-up/email", { email, password, name: "Ayu", callbackURL: "/" })

// The Cookie header a browser would send back after this response.
const cookiesFrom = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")

const sessionOf = (cookie: string) =>
  send("/get-session?disableCookieCache=true", { headers: { cookie } }).pipe(
    Effect.flatMap((response) =>
      Effect.promise(
        () =>
          response.json() as Promise<{
            user: { email: string; emailVerified: boolean }
          } | null>
      )
    )
  )

// The path under /api/auth of the link in a mail.
const linkIn = (mail: Mail | undefined) => {
  const url = mail?.text.match(/https?:\/\/\S+/)?.[0] ?? ""
  return url.slice(`${BASE_URL}/api/auth`.length)
}

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
    ["seven", "1234567", 400],
    ["eight", "12345678", 200],
  ] as const)(
    "with a %s-character password answers %s",
    ([, password, status]) => {
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
