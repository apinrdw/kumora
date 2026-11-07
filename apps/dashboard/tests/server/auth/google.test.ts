import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import { googleClient, googleSignInOn } from "@/server/auth/google"
import type { Mail } from "@/server/auth/mailer"

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

const GOOGLE = { clientId: "google-client-id", clientSecret: "google-secret" }
const RETURN_TO = "/market-live"
const ERROR_URL = "/sign-in?redirect=%2Fmarket-live"

const startGoogle = post("/sign-in/social", {
  provider: "google",
  callbackURL: RETURN_TO,
  errorCallbackURL: ERROR_URL,
})

describe("googleSignInOn", () => {
  it.each([
    ["production", true],
    ["staging", true],
    ["preview", false],
    ["dev", false],
    ["test", false],
  ] as const)("on a %s stage is %s", (kind, on) => {
    assert.strictEqual(googleSignInOn(kind), on)
  })
})

describe("googleClient", () => {
  it("is the bound client id and secret", () => {
    assert.deepStrictEqual(
      googleClient({
        GOOGLE_CLIENT_ID: GOOGLE.clientId,
        GOOGLE_CLIENT_SECRET: GOOGLE.clientSecret,
      }),
      GOOGLE
    )
  })

  it("is absent on a stage that binds no client", () => {
    assert.isUndefined(googleClient({}))
  })
})

describe("Google sign-in", () => {
  it.effect("sends the visitor to Google where a client is configured", () => {
    const { layer } = seam(undefined, { google: GOOGLE })
    return Effect.gen(function* () {
      const response = yield* startGoogle
      assert.strictEqual(response.status, 200)
      const { url } = yield* json<{ url: string }>(response)
      const authorize = new URL(url)
      assert.strictEqual(
        `${authorize.origin}${authorize.pathname}`,
        "https://accounts.google.com/o/oauth2/v2/auth"
      )
      assert.strictEqual(
        authorize.searchParams.get("redirect_uri"),
        `${BASE_URL}/api/auth/callback/google`
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("is not offered where no client is configured", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const response = yield* startGoogle
      assert.strictEqual(response.status, 404)
    }).pipe(Effect.provide(layer))
  })
})

// Google's side of the callback: the token endpoint answers with an id token
// for `email`, which Better Auth decodes for the profile.
const googleReturns = Effect.fnUntraced(function* (email: string) {
  const started = yield* startGoogle
  const { url } = yield* json<{ url: string }>(started)
  const state = new URL(url).searchParams.get("state") ?? ""
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const target = input instanceof Request ? input.url : String(input)
    if (target !== "https://oauth2.googleapis.com/token")
      return Promise.reject(new Error(`unexpected fetch ${target}`))
    return Promise.resolve(
      Response.json({
        access_token: "google-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken({
          sub: "google-user-1",
          email,
          email_verified: true,
          name: "Ayu",
        }),
      })
    )
  })
  return yield* send(`/callback/google?code=google-code&state=${state}`, {
    headers: { cookie: cookiesFrom(started) },
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())))
})

describe("Google on the email of a password account", () => {
  it.effect(
    "is refused while the account is unverified, back on sign-in",
    () => {
      const { layer } = seam(undefined, { google: GOOGLE })
      return Effect.gen(function* () {
        yield* signUp("ayu@example.com")
        const response = yield* googleReturns("ayu@example.com")
        assert.strictEqual(response.status, 302)
        assert.strictEqual(
          response.headers.get("location"),
          `${ERROR_URL}&error=account_not_linked`
        )
        assert.isNull(yield* sessionOf(cookiesFrom(response)))
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("links to it once it is verified, and signs in", () => {
    const { layer, mails } = seam(undefined, { google: GOOGLE })
    return Effect.gen(function* () {
      yield* verified(mails, "ayu@example.com")
      const response = yield* googleReturns("ayu@example.com")
      assert.strictEqual(response.status, 302)
      assert.strictEqual(response.headers.get("location"), RETURN_TO)
      const cookie = cookiesFrom(response)
      assert.strictEqual(
        (yield* sessionOf(cookie))?.user.email,
        "ayu@example.com"
      )
      const accounts = yield* json<ReadonlyArray<{ providerId: string }>>(
        yield* send("/list-accounts", { headers: { cookie } })
      )
      assert.deepStrictEqual(
        accounts.map((account) => account.providerId).sort(),
        ["credential", "google"]
      )
    }).pipe(Effect.provide(layer))
  })
})

describe("a Google sign-up", () => {
  // Google vouches for the email, so the account is created verified.
  it.effect("on the admin list is admin at once", () => {
    const { layer } = seam(undefined, { google: GOOGLE })
    return Effect.gen(function* () {
      const response = yield* googleReturns(ADMIN_EMAIL)
      const session = yield* sessionOf(cookiesFrom(response))
      assert.strictEqual(session?.user.role, "admin")
    }).pipe(Effect.provide(layer))
  })

  it.effect("off the list is a member", () => {
    const { layer } = seam(undefined, { google: GOOGLE })
    return Effect.gen(function* () {
      const response = yield* googleReturns("ayu@example.com")
      const session = yield* sessionOf(cookiesFrom(response))
      assert.strictEqual(session?.user.role, "member")
    }).pipe(Effect.provide(layer))
  })
})

describe("Google sign-in of a banned account", () => {
  it.effect("is refused, back on sign-in with BANNED_USER", () => {
    const { layer, mails, database } = seam(undefined, { google: GOOGLE })
    return Effect.gen(function* () {
      yield* signUp(ADMIN_EMAIL)
      const admin = cookiesFrom(yield* send(linkIn(mails.at(-1))))
      yield* googleReturns("ayu@example.com")
      const { id } = database
        .prepare(`select "id" from "user" where "email" = ?`)
        .get("ayu@example.com") as { id: string }
      const banned = yield* post(
        "/admin/ban-user",
        { userId: id },
        { cookie: admin }
      )
      assert.strictEqual(banned.status, 200)
      const response = yield* googleReturns("ayu@example.com")
      assert.strictEqual(response.status, 302)
      const location = new URL(response.headers.get("location") ?? "", BASE_URL)
      assert.strictEqual(
        `${location.pathname}${location.search}`.split("&error=")[0],
        ERROR_URL
      )
      assert.strictEqual(location.searchParams.get("error"), "BANNED_USER")
      assert.isNull(yield* sessionOf(cookiesFrom(response)))
    }).pipe(Effect.provide(layer))
  })
})

const verified = Effect.fnUntraced(function* (
  mails: ReadonlyArray<Mail>,
  email: string
) {
  yield* signUp(email)
  yield* send(linkIn(mails.at(-1)))
})

const json = <A>(response: Response) =>
  Effect.promise(() => response.json() as Promise<A>)

// An unsigned JWT: Better Auth reads the profile from the id token Google's
// token endpoint returns without checking its signature.
const idToken = (claims: Record<string, unknown>) =>
  [{ alg: "RS256", typ: "JWT" }, claims, "signature"]
    .map((part) =>
      Buffer.from(
        typeof part === "string" ? part : JSON.stringify(part)
      ).toString("base64url")
    )
    .join(".")
