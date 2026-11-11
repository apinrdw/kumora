import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { niceScale } from "@/components/k/charts/scale"

describe("niceScale", () => {
  it.effect("rounds a ragged price range outward to a 1-2-5 step", () =>
    Effect.gen(function* () {
      expect(yield* niceScale(9193, 9227)).toEqual({
        domain: [9190, 9230],
        ticks: [9190, 9200, 9210, 9220, 9230],
      })
    })
  )

  it.effect("picks a 2.5 step when it fits the requested tick count", () =>
    Effect.gen(function* () {
      expect((yield* niceScale(0, 100)).ticks).toEqual([0, 25, 50, 75, 100])
    })
  )

  it.effect("a flat series still gets a domain that contains the value", () =>
    Effect.gen(function* () {
      expect(yield* niceScale(500, 500)).toEqual({
        domain: [400, 600],
        ticks: [400, 600],
      })
    })
  )

  it.effect("an all-zero series falls back to a unit span", () =>
    Effect.gen(function* () {
      expect(yield* niceScale(0, 0)).toEqual({ domain: [0, 0], ticks: [0] })
    })
  )
})
