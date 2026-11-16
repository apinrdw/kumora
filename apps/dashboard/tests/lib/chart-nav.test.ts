import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { chartMinutes, panShift, windowAround } from "@/lib/chart-nav"

const at = (wib: string) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`))

describe("the footprint chart's 10-minute window", () => {
  it.effect(
    "shows exactly 10 whole minutes around a minute: a range 9 wide on whole indices",
    () =>
      Effect.gen(function* () {
        expect(yield* windowAround(20, 10)).toEqual({ from: 16, to: 25 })
        // A fractional middle (a resize mid-pan) lands on whole indices.
        expect(yield* windowAround(20.6, 10)).toEqual({ from: 17, to: 26 })
      })
  )
})

describe("a pan between the charts", () => {
  it.effect("moves by the minutes the range moved when its width is kept", () =>
    Effect.gen(function* () {
      expect(
        yield* panShift({ from: 10, to: 40 }, { from: 7.5, to: 37.5 })
      ).toBe(-2.5)
    })
  )

  it.effect("is no pan when the width changed (a zoom) or nothing moved", () =>
    Effect.gen(function* () {
      expect(
        yield* panShift({ from: 10, to: 40 }, { from: 12, to: 40 })
      ).toBeUndefined()
      expect(
        yield* panShift({ from: 10, to: 40 }, { from: 10, to: 40 })
      ).toBeUndefined()
    })
  )
})

describe("the minutes both charts draw", () => {
  it.effect(
    "are the candles' minutes and each relay gap's minutes without a candle, ascending",
    () =>
      Effect.gen(function* () {
        const drawn = yield* chartMinutes(
          [at("09:00:00"), at("09:01:00"), at("09:05:00")],
          [
            {
              from: DateTime.makeUnsafe(at("09:01:30")),
              to: DateTime.makeUnsafe(at("09:03:10")),
            },
          ],
          at("09:05:00")
        )
        expect(drawn.all).toEqual([
          at("09:00:00"),
          at("09:01:00"),
          at("09:02:00"),
          at("09:03:00"),
          at("09:05:00"),
        ])
        // 09:01 has a candle: only the blank minutes are whitespace.
        expect(drawn.blank).toEqual([at("09:02:00"), at("09:03:00")])
        expect(drawn.runs).toEqual([[at("09:02:00"), at("09:03:00")]])
      })
  )
})
