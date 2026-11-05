import { Schema } from "effect"
import { describe, expect, test } from "vitest"

import { MarketOverview } from "@/features/shell/schema"
import { MARKET_OVERVIEW } from "@/lib/market"

const decode = Schema.decodeUnknownSync(MarketOverview)

describe("MarketOverview", () => {
  test("decodes the market fixture overview", () => {
    expect(decode(MARKET_OVERVIEW)).toEqual(MARKET_OVERVIEW)
  })

  test("rejects a malformed Symbol on the net foreign tape", () => {
    const bad = { ...MARKET_OVERVIEW, netForeignTape: [["bbri", 318]] }
    expect(() => decode(bad)).toThrow(/netForeignTape/)
  })

  test("rejects an overview without its as-of", () => {
    const { asOf: _, ...bad } = MARKET_OVERVIEW
    expect(() => decode(bad)).toThrow(/asOf/)
  })
})
