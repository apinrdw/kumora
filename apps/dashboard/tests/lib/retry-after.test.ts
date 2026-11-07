import { describe, expect, it } from "vitest"

import { retryAfter, tooManyAttempts } from "@/lib/retry-after"

describe("tooManyAttempts", () => {
  it.each([
    [1, "Try again in 1 minute."],
    [60, "Try again in 1 minute."],
    [61, "Try again in 2 minutes."],
    [3600, "Try again in 60 minutes."],
    [Number.NaN, "Try again in 1 minute."],
  ])("says %s seconds as whole minutes, rounded up", (seconds, text) => {
    expect(tooManyAttempts(seconds)).toBe(`Too many attempts. ${text}`)
  })
})

describe("retryAfter", () => {
  it("reads the wait from a refused response's X-Retry-After", () => {
    const retry = retryAfter()
    retry.onError({
      response: new Response(null, {
        status: 429,
        headers: { "X-Retry-After": "540" },
      }),
    })
    expect(retry.messageFor({ status: 429 }, "Couldn't.")).toBe(
      "Too many attempts. Try again in 9 minutes."
    )
  })

  it("says the fallback for any other refusal", () => {
    const retry = retryAfter()
    retry.onError({ response: new Response(null, { status: 500 }) })
    expect(retry.messageFor({ status: 500 }, "Couldn't.")).toBe("Couldn't.")
  })
})
