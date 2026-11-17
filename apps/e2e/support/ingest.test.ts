import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { freshCode, freshTradeNumbers } from "./ingest"

// Two workers of a run ask in the same millisecond: the clock stands still.
describe("fresh numbers and codes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-17T03:00:00.000Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("gives two tests asking in one millisecond trade numbers 100,000 apart", () => {
    const first = freshTradeNumbers()
    const second = freshTradeNumbers()
    expect(Math.abs(second - first)).toBeGreaterThanOrEqual(100_000)
  })

  it("gives two tests asking in one millisecond different codes", () => {
    expect(freshCode("BS")).not.toBe(freshCode("BS"))
  })
})
