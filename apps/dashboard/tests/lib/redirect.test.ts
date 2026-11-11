import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { safeRedirect } from "@/lib/redirect"

describe("safeRedirect", () => {
  it.effect.each([
    ["/market-live", "/market-live"],
    ["/market-live?day=2026-11-06#tape", "/market-live?day=2026-11-06#tape"],
    ["/", "/"],
  ])("keeps the same-origin path %s", ([raw, expected]) =>
    Effect.gen(function* () {
      expect(yield* safeRedirect(raw)).toBe(expected)
    })
  )

  it.effect.each([
    ["another origin", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a protocol-relative URL without a slash", "//evil.example"],
    ["a path that normalizes to protocol-relative", "/a/..//evil.example"],
    ["a backslash host", "/\\evil.example/"],
    ["a backslash host without a slash", "/\\evil.example"],
    ["an encoded slash Better Auth refuses", "/%2F/evil.example"],
    ["a tab the URL parser drops", "/\t/evil.example/"],
    ["a script URL", "javascript:alert(1)"],
    ["a relative path", "market-live"],
    ["an empty value", ""],
    ["no value", undefined],
    ["a number", 42],
  ])("sends %s home", ([_, raw]) =>
    Effect.gen(function* () {
      expect(yield* safeRedirect(raw)).toBe("/")
    })
  )
})
