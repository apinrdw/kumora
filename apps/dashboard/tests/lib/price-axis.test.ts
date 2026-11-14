import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  labelPrices,
  priceLabel,
  rowCappedRange,
  snapToTick,
} from "@/lib/price-axis"

describe("a price on the IDX tick axis", () => {
  it.effect("snaps to the nearest valid price of its band", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.forEach(
          [10_619, 10_612.4, 199.4, 1_996.4, 2_004, 4_996],
          snapToTick
        )
      ).toEqual([10_625, 10_600, 199, 1_995, 2_000, 5_000])
    })
  )

  it.effect("reads with commas, snapped", () =>
    Effect.gen(function* () {
      expect(yield* priceLabel(10_619)).toBe("10,625")
    })
  )
})

describe("the price axis labels", () => {
  it.effect(
    "sit on every tick when a row is 13 px or taller, inside the pane",
    () =>
      Effect.gen(function* () {
        // 25-wide ticks 20 px tall: 10,500 to 10,600.
        expect(
          yield* labelPrices({ bottom: 10_490, top: 10_610, rowPx: 20 })
        ).toEqual([10_500, 10_525, 10_550, 10_575, 10_600])
      })
  )

  it.effect("thin to every 2nd, 4th, 8th tick below 13 px a row", () =>
    Effect.gen(function* () {
      expect(
        yield* labelPrices({ bottom: 10_490, top: 10_610, rowPx: 12 })
      ).toEqual([10_500, 10_550, 10_600])
      expect(
        yield* labelPrices({ bottom: 10_390, top: 10_610, rowPx: 3.5 })
      ).toEqual([10_400, 10_500, 10_600])
    })
  )
})

describe("chart 2's rows", () => {
  it.effect(
    "are capped at 36 px a tick: a quiet range widens around its middle",
    () =>
      Effect.gen(function* () {
        // 352 px of plot (88% of 400) holds 9.78 rows of 36 px.
        const range = yield* rowCappedRange({
          minValue: 10_500,
          maxValue: 10_525,
          paneHeight: 400,
        })
        expect(range.minValue + range.maxValue).toBe(21_025)
        expect(((range.maxValue - range.minValue) / 25) * 36).toBeCloseTo(352)
      })
  )

  it.effect("still fit a wide range by shrinking rows", () =>
    Effect.gen(function* () {
      expect(
        yield* rowCappedRange({
          minValue: 10_000,
          maxValue: 11_000,
          paneHeight: 400,
        })
      ).toEqual({ minValue: 9_987.5, maxValue: 11_012.5 })
    })
  )
})
