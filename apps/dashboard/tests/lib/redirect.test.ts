import { describe, expect, test } from "vitest"

import { safeRedirect } from "@/lib/redirect"

describe("safeRedirect", () => {
  test.each([
    ["/market-live", "/market-live"],
    ["/market-live?day=2026-11-06#tape", "/market-live?day=2026-11-06#tape"],
    ["/", "/"],
  ])("keeps the same-origin path %s", (raw, expected) => {
    expect(safeRedirect(raw)).toBe(expected)
  })

  test.each([
    ["another origin", "https://evil.example/"],
    ["a protocol-relative URL", "//evil.example/"],
    ["a backslash host", "/\\evil.example/"],
    ["a tab the URL parser drops", "/\t/evil.example/"],
    ["a script URL", "javascript:alert(1)"],
    ["a relative path", "market-live"],
    ["an empty value", ""],
    ["no value", undefined],
    ["a number", 42],
  ])("sends %s home", (_, raw) => {
    expect(safeRedirect(raw)).toBe("/")
  })
})
