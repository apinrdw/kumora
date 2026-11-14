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
          yield* labelPrices({ bottom: 10_490, top: 10_610, height: 96 })
        ).toEqual([10_500, 10_525, 10_550, 10_575, 10_600])
      })
  )

  it.effect("thin to every 2nd, 4th, 8th tick below 13 px a row", () =>
    Effect.gen(function* () {
      // 25-wide ticks 12 px tall, then 3.5 px tall.
      expect(
        yield* labelPrices({ bottom: 10_490, top: 10_610, height: 57.6 })
      ).toEqual([10_500, 10_550, 10_600])
      expect(
        yield* labelPrices({ bottom: 10_390, top: 10_610, height: 30.8 })
      ).toEqual([10_400, 10_500, 10_600])
    })
  )

  // The labels for `view`: `off` lists those that aren't a valid price of
  // their own band, `cramped` those less than 13 px over the one below.
  const onTicks = Effect.fnUntraced(function* (view: {
    readonly bottom: number
    readonly top: number
    readonly height: number
  }) {
    const prices = yield* labelPrices(view)
    const pxPerPrice = view.height / (view.top - view.bottom)
    const off = yield* Effect.filter(prices, (at) =>
      Effect.map(snapToTick(at), (snapped) => snapped !== at)
    )
    const cramped = prices.filter(
      (at, index) => index > 0 && (at - prices[index - 1]!) * pxPerPrice < 13
    )
    return { prices, off, cramped }
  })

  const clean = (prices: ReadonlyArray<number>) => ({
    prices,
    off: [],
    cramped: [],
  })

  it.effect("step by each band's own tick across a band edge", () =>
    Effect.gen(function* () {
      // 2 px a rupiah: 10-wide rows below 5,000, 25-wide from it.
      expect(
        yield* onTicks({ bottom: 4_950, top: 5_040, height: 180 })
      ).toEqual(clean([4_950, 4_960, 4_970, 4_980, 4_990, 5_000, 5_025]))
      expect(yield* onTicks({ bottom: 190, top: 210, height: 400 })).toEqual(
        clean([
          190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 202, 204, 206,
          208, 210,
        ])
      )
      expect(yield* onTicks({ bottom: 490, top: 510, height: 200 })).toEqual(
        clean([490, 492, 494, 496, 498, 500, 505, 510])
      )
      expect(yield* onTicks({ bottom: 1_990, top: 2_010, height: 80 })).toEqual(
        clean([1_990, 1_995, 2_000, 2_010])
      )
    })
  )

  it.effect("thin each band on its own ticks across a band edge", () =>
    Effect.gen(function* () {
      // Half a px a rupiah: every 4th 10-wide tick, every 2nd 25-wide one.
      expect(yield* onTicks({ bottom: 4_950, top: 5_040, height: 45 })).toEqual(
        clean([4_960, 5_000])
      )
      expect(yield* onTicks({ bottom: 190, top: 210, height: 40 })).toEqual(
        clean([192, 200, 208])
      )
      expect(yield* onTicks({ bottom: 1_990, top: 2_010, height: 40 })).toEqual(
        clean([1_990, 2_000, 2_010])
      )
    })
  )

  it.effect("keep a band's first price over a closer label below it", () =>
    Effect.gen(function* () {
      // 3 px a rupiah: every 4th 2-wide tick below 500 puts 496 12 px under
      // 500, every 5-wide tick from it.
      expect(yield* onTicks({ bottom: 490, top: 510, height: 60 })).toEqual(
        clean([500, 505, 510])
      )
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
