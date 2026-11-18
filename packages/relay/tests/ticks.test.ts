import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { WibDate, priceLimitsOf, tickAt, ticksBetween } from "@workspace/relay"

const today = WibDate.make("2026-11-18")
const next = WibDate.make("2027-01-04")

describe("tick sizes", () => {
  it.effect("each band's tick starts at its edge", () =>
    Effect.gen(function* () {
      const ticks = []
      for (const price of [1, 199, 200, 499, 500, 1995, 2000, 4990, 5000])
        ticks.push(yield* tickAt(price))
      assert.deepStrictEqual(ticks, [1, 1, 2, 2, 5, 5, 10, 10, 25])
    })
  )

  it.effect("a step across a band edge counts each price on its own tick", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* ticksBetween(498, 500), 1)
      // 494, 496, 498 and 500 on Rp2, then 505 on Rp5.
      assert.strictEqual(yield* ticksBetween(494, 505), 4)
      assert.strictEqual(yield* ticksBetween(4980, 5050), 4)
      assert.strictEqual(yield* ticksBetween(100, 100), 0)
    })
  )
})

describe("price limits", () => {
  it.effect("until 2026-12-31 the lower limit is 7% from Rp15", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* priceLimitsOf(100, today, "regular"), {
        upper: 135,
        lower: 93,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(1000, today, "regular"), {
        upper: 1250,
        lower: 930,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(8000, today, "regular"), {
        upper: 9600,
        // 7,440 on Rp25.
        lower: 7450,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(15, today, "regular"), {
        upper: 20,
        lower: 14,
      })
    })
  )

  it.effect("below Rp15 the lower limit is Rp1, and Rp1–10 move Rp1", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* priceLimitsOf(14, today, "regular"), {
        upper: 18,
        lower: 13,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(10, today, "regular"), {
        upper: 11,
        lower: 9,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(1, today, "regular"), {
        upper: 2,
        lower: 1,
      })
    })
  )

  it.effect("a limit lands on a valid tick, rounded toward the reference", () =>
    Effect.gen(function* () {
      // 2,625 on Rp10 and 1,953 on Rp5.
      assert.deepStrictEqual(yield* priceLimitsOf(2100, today, "regular"), {
        upper: 2620,
        lower: 1955,
      })
    })
  )

  it.effect("from 2027-01-01 the limits are symmetric", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* priceLimitsOf(1000, next, "regular"), {
        upper: 1250,
        lower: 750,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(15, next, "regular"), {
        upper: 20,
        lower: 10,
      })
    })
  )

  it.effect("a Special Monitoring Board code moves 10%, or Rp1 to Rp10", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* priceLimitsOf(100, today, "special"), {
        upper: 110,
        lower: 90,
      })
      assert.deepStrictEqual(yield* priceLimitsOf(8, today, "special"), {
        upper: 9,
        lower: 7,
      })
    })
  )
})
