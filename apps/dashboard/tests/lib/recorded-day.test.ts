import {
  StockCode,
  WibDate,
  type Candle,
  type RecordedCandles,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { closeOf, dayStateAt, lastCloseAt } from "@/lib/recorded-day"

const BBCA = StockCode.make("BBCA")

// BBCA's candle for the 2026-11-06 minute starting at `wib` (HH:MM).
function candle(wib: string, figures: Partial<Candle> = {}): Candle {
  return {
    code: BBCA,
    minute: DateTime.makeUnsafe(`2026-11-06T${wib}:00+07:00`),
    open: 9_000,
    high: 9_000,
    low: 9_000,
    close: 9_000,
    volume: 10,
    value: 9_000_000,
    buyValue: 0,
    sellValue: 0,
    frequency: 1,
    ...figures,
  }
}

const day: RecordedCandles = {
  code: BBCA,
  previousClose: 8_900,
  candles: [
    candle("09:00", { open: 8_950, high: 9_025, low: 8_925, close: 9_000 }),
    candle("09:01", { high: 9_100, close: 9_075, volume: 30, frequency: 4 }),
    candle("16:15", { low: 8_850, close: 8_875, volume: 5, value: 4_437_500 }),
  ],
}

describe("a recorded day's watchlist row", () => {
  it.effect("at the close it holds the whole day", () =>
    Effect.gen(function* () {
      expect(
        yield* dayStateAt(day, yield* closeOf(WibDate.make("2026-11-06")))
      ).toEqual({
        code: BBCA,
        last: 8_875,
        previousClose: 8_900,
        change: { amount: -25, percent: -25 / 89 },
        open: 8_950,
        high: 9_100,
        low: 8_850,
        volume: 45,
        value: 22_437_500,
        frequency: 6,
        asOf: DateTime.makeUnsafe("2026-11-06T16:16:00+07:00"),
        provenance: "Stockbit",
      })
    })
  )

  it.effect("a cursor counts its own minute and none after it", () =>
    Effect.gen(function* () {
      const state = yield* dayStateAt(
        day,
        DateTime.makeUnsafe("2026-11-06T09:01:30+07:00")
      )
      expect(state).toMatchObject({
        last: 9_075,
        change: { amount: 175, percent: 175 / 89 },
        high: 9_100,
        volume: 40,
        frequency: 5,
        asOf: DateTime.makeUnsafe("2026-11-06T09:02:00+07:00"),
      })
    })
  )

  it.effect("a code with no candle by the cursor has no figures yet", () =>
    Effect.gen(function* () {
      expect(
        yield* dayStateAt(day, DateTime.makeUnsafe("2026-11-06T08:59:59+07:00"))
      ).toBeUndefined()
      expect(
        yield* dayStateAt(
          { code: BBCA, candles: [] },
          yield* closeOf(WibDate.make("2026-11-06"))
        )
      ).toBeUndefined()
    })
  )

  it.effect(
    "without a previous close the row has no change, not one run from the open",
    () =>
      Effect.gen(function* () {
        const { previousClose: _, ...noClose } = day
        const state = yield* dayStateAt(
          noClose,
          yield* closeOf(WibDate.make("2026-11-06"))
        )
        expect(state).toMatchObject({ last: 8_875 })
        expect(state).not.toHaveProperty("previousClose")
        expect(state).not.toHaveProperty("change")
      })
  )
})

describe("the chart header's last close at the cursor", () => {
  const at = (wib: string) => DateTime.makeUnsafe(`2026-11-06T${wib}+07:00`)

  it.effect("is the latest candle's close at or before the cursor", () =>
    Effect.gen(function* () {
      expect(yield* lastCloseAt(day.candles, at("09:01:30"))).toBe(9_075)
      expect(yield* lastCloseAt(day.candles, at("12:00:00"))).toBe(9_075)
    })
  )

  it.effect("is none before the code's first candle, never a later close", () =>
    Effect.gen(function* () {
      expect(yield* lastCloseAt(day.candles, at("08:59:59"))).toBeUndefined()
    })
  )

  it.effect("without a cursor it is the last candle's close", () =>
    Effect.gen(function* () {
      expect(yield* lastCloseAt(day.candles, undefined)).toBe(8_875)
    })
  )
})
