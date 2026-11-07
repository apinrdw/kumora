// Abuse protection through the handler seam: Turnstile on the forms that send
// mail, the per-IP limits, and the per-address mail cap.
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

import { cookiesFrom, post, seam, send, signUp } from "./seam.ts"

const HOUR = 60 * 60
const DAY = 24 * HOUR

const ip = (n: number) => ({ "cf-connecting-ip": `198.51.100.${n}` })

const body = (response: Response) =>
  Effect.promise(
    () => response.json() as Promise<{ code?: string; message?: string }>
  )

const retryAfter = (response: Response) =>
  Number(response.headers.get("X-Retry-After"))

const requestReset = (email: string, headers?: Record<string, string>) =>
  post("/request-password-reset", { email, redirectTo: "/" }, headers)

const resend = (email: string, headers?: Record<string, string>) =>
  post("/send-verification-email", { email }, headers)

// Time passes for Better Auth (Date) and for our Effect callbacks, which run
// on the test's clock.
const advance = (seconds: number) =>
  Effect.gen(function* () {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + seconds * 1000)
    yield* TestClock.adjust(Duration.seconds(seconds))
  })

const realTimers = Effect.ensuring(Effect.sync(() => vi.useRealTimers()))

describe("Turnstile", () => {
  it.effect.each([
    [
      "sign-up",
      (headers: Record<string, string>) =>
        signUp("ayu@example.com", undefined, headers),
    ],
    [
      "reset request",
      (headers: Record<string, string>) =>
        requestReset("ayu@example.com", headers),
    ],
  ] as const)("refuses a %s with no token or a failed one", ([, submit]) => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const missing = yield* submit({ "x-captcha-response": "" })
      assert.strictEqual(missing.status, 400)
      assert.strictEqual((yield* body(missing)).code, "MISSING_RESPONSE")
      const failed = yield* submit({ "x-captcha-response": "a bot's guess" })
      assert.strictEqual(failed.status, 403)
      assert.strictEqual((yield* body(failed)).code, "VERIFICATION_FAILED")
      assert.strictEqual(mails.length, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("never asks sign-in for a token", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      yield* signUp("ayu@example.com")
      const response = yield* post(
        "/sign-in/email",
        { email: "ayu@example.com", password: "correct horse" },
        { "x-captcha-response": "" }
      )
      assert.strictEqual(response.status, 200)
    }).pipe(Effect.provide(layer))
  })
})

describe("per-IP rate limits", () => {
  const signIn = (n: number, headers?: Record<string, string>) =>
    post(
      "/sign-in/email",
      { email: `nobody-${n}@example.com`, password: "a wrong guess" },
      headers
    )

  // Each rule: what one IP may do in the window, then the next is refused.
  it.effect.each([
    ["sign-in", 10, 60, signIn],
    [
      "sign-up",
      5,
      HOUR,
      (n: number, h?: Record<string, string>) =>
        signUp(`ayu-${n}@example.com`, undefined, h),
    ],
    [
      "resend verification",
      3,
      HOUR,
      (n: number, h?: Record<string, string>) =>
        resend(`ayu-${n}@example.com`, h),
    ],
    [
      "reset request",
      3,
      HOUR,
      (n: number, h?: Record<string, string>) =>
        requestReset(`ayu-${n}@example.com`, h),
    ],
  ] as const)(
    "lets one IP %s %s times per %s s, then answers 429 until the window passes",
    ([, max, window, attempt]) => {
      const { layer } = seam()
      return Effect.gen(function* () {
        for (let n = 0; n < max; n++)
          assert.notStrictEqual((yield* attempt(n)).status, 429)
        const refused = yield* attempt(max)
        assert.strictEqual(refused.status, 429)
        assert.isAbove(retryAfter(refused), window - 5)
        assert.isAtMost(retryAfter(refused), window)
        // Another client is counted on its own.
        assert.notStrictEqual((yield* attempt(max + 1, ip(2))).status, 429)
        yield* advance(window)
        assert.notStrictEqual((yield* attempt(max + 2)).status, 429)
      }).pipe(realTimers, Effect.provide(layer))
    },
    { timeout: 15_000 }
  )

  it.effect("leaves other routes at 100 per 10 s", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const cookie = cookiesFrom(yield* signUp("ayu@example.com"))
      const getSession = () => send("/get-session", { headers: { cookie } })
      // Sign-up's own request used none of this route's count.
      for (let n = 0; n < 100; n++)
        assert.strictEqual((yield* getSession()).status, 200)
      assert.strictEqual((yield* getSession()).status, 429)
    }).pipe(Effect.provide(layer))
  })
})

describe("per-address mail cap", () => {
  // The resends come from different IPs, so only the cap can refuse them.
  const resendFrom = (email: string, n: number) => resend(email, ip(n))

  it.effect(
    "refuses the sixth mail to an address in a day with 429 and the time left",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        yield* signUp("ayu@example.com")
        for (let n = 1; n <= 4; n++)
          assert.strictEqual(
            (yield* resendFrom("ayu@example.com", n)).status,
            200
          )
        assert.strictEqual(mails.length, 5)

        const refused = yield* resendFrom("ayu@example.com", 5)
        assert.strictEqual(refused.status, 429)
        assert.strictEqual((yield* body(refused)).code, "TooManyMails")
        assert.isAbove(retryAfter(refused), DAY - 60)
        assert.isAtMost(retryAfter(refused), DAY)
        assert.strictEqual(mails.length, 5)
      }).pipe(Effect.provide(layer))
    },
    { timeout: 15_000 }
  )

  it.effect(
    "counts reset mails with verification mails, and a capped reset still answers neutrally",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        yield* signUp("ayu@example.com")
        for (let n = 1; n <= 4; n++)
          yield* requestReset("ayu@example.com", ip(n))
        assert.strictEqual(mails.length, 5)

        const known = yield* requestReset("ayu@example.com", ip(5))
        const unknown = yield* requestReset("nobody@example.com", ip(6))
        assert.strictEqual(known.status, 200)
        assert.strictEqual(
          yield* Effect.promise(() => known.text()),
          yield* Effect.promise(() => unknown.text())
        )
        assert.strictEqual(mails.length, 5)
        assert.strictEqual(
          (yield* resendFrom("ayu@example.com", 7)).status,
          429
        )
      }).pipe(Effect.provide(layer))
    },
    { timeout: 15_000 }
  )

  it.effect(
    "caps each address on its own, and opens again a day after the first mail",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        yield* signUp("ayu@example.com")
        for (let n = 1; n <= 4; n++) yield* resendFrom("ayu@example.com", n)
        yield* signUp("bima@example.com", undefined, ip(9))
        assert.strictEqual(mails.at(-1)?.to, "bima@example.com")

        yield* advance(DAY - 60)
        assert.strictEqual(
          (yield* resendFrom("ayu@example.com", 10)).status,
          429
        )
        yield* advance(60)
        assert.strictEqual(
          (yield* resendFrom("ayu@example.com", 11)).status,
          200
        )
        assert.strictEqual(mails.at(-1)?.to, "ayu@example.com")
      }).pipe(realTimers, Effect.provide(layer))
    },
    { timeout: 15_000 }
  )
})
