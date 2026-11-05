import { describe, expect, test } from "vitest"

import type { ProfileLevel } from "@/domain/trade"
import { profileRows } from "@/features/radar/profile-rows"

const level = (
  price: number,
  buy = 1,
  sell = 0,
  unspecified = 0
): ProfileLevel => ({
  price,
  buy,
  sell,
  unspecified,
})

describe("profileRows", () => {
  test("one row per price, a tick tall, while the range fits", () => {
    expect(profileRows([level(100), level(105, 0, 2), level(115)], 10)).toEqual(
      [
        { from: 97.5, to: 102.5, buy: 1, sell: 0, unspecified: 0 },
        { from: 102.5, to: 107.5, buy: 0, sell: 2, unspecified: 0 },
        { from: 112.5, to: 117.5, buy: 1, sell: 0, unspecified: 0 },
      ]
    )
  })

  test("a range too wide to draw buckets its prices, and keeps every lot", () => {
    const levels = Array.from({ length: 100 }, (_, i) =>
      level(1000 + i * 5, 1, 2, 3)
    )
    const rows = profileRows(levels, 20)
    expect(rows.length).toBeLessThanOrEqual(20)
    const total = (key: "buy" | "sell" | "unspecified") =>
      rows.reduce((sum, r) => sum + r[key], 0)
    expect([total("buy"), total("sell"), total("unspecified")]).toEqual([
      100, 200, 300,
    ])
    expect(rows[0]?.from).toBeLessThanOrEqual(1000)
    expect(rows.at(-1)?.to).toBeGreaterThanOrEqual(1495)
  })

  test("a single price is still a row", () => {
    expect(profileRows([level(50)], 10)).toEqual([
      { from: 49.5, to: 50.5, buy: 1, sell: 0, unspecified: 0 },
    ])
  })

  test("no trades, no rows", () => {
    expect(profileRows([], 10)).toEqual([])
  })
})
