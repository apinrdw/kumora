import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { MarketOverview } from "@/features/shell/schema"
import { AppLayer } from "@/lib/runtime"
import { Market } from "@/services/market"

layer(AppLayer)("Market", (it) => {
  it.effect("serves an overview that decodes against MarketOverview", () =>
    Effect.gen(function* () {
      const overview = yield* (yield* Market).overview
      const decoded = yield* Schema.decodeEffect(MarketOverview)(overview)
      expect(decoded.ihsg).toEqual({ last: 7243.18, changePct: 0.42 })
      expect(decoded.foreignNet).toBe(534e9)
      expect(decoded.netForeignTape).toHaveLength(12)
      expect(decoded.netForeignTape[0]).toEqual(["BBRI", 318])
    })
  )

  it.effect("carries the as-of of the price feed", () =>
    Effect.gen(function* () {
      const overview = yield* (yield* Market).overview
      expect(overview.asOf).toBe("2026-10-23T07:45:00Z")
    })
  )
})
