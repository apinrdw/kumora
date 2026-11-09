import {
  StockCode,
  WibDate,
  type Candle,
  type RecordedCandles,
} from "@workspace/relay"
import { DateTime } from "effect"
import { describe, expect, test } from "vitest"

import { closeOf, dayStateAt } from "@/lib/recorded-day"

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
  test("at the close it holds the whole day", () => {
    expect(dayStateAt(day, closeOf(WibDate.make("2026-11-06")))).toEqual({
      code: BBCA,
      last: 8_875,
      previousClose: 8_900,
      change: -25,
      changePercent: -25 / 89,
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

  test("a cursor counts its own minute and none after it", () => {
    const state = dayStateAt(
      day,
      DateTime.makeUnsafe("2026-11-06T09:01:30+07:00")
    )
    expect(state).toMatchObject({
      last: 9_075,
      change: 175,
      high: 9_100,
      volume: 40,
      frequency: 5,
      asOf: DateTime.makeUnsafe("2026-11-06T09:02:00+07:00"),
    })
  })

  test("a code with no candle by the cursor has no figures yet", () => {
    expect(
      dayStateAt(day, DateTime.makeUnsafe("2026-11-06T08:59:59+07:00"))
    ).toBeUndefined()
    expect(
      dayStateAt(
        { code: BBCA, candles: [] },
        closeOf(WibDate.make("2026-11-06"))
      )
    ).toBeUndefined()
  })

  test("without a previous close the change runs from the open", () => {
    const { previousClose: _, ...noClose } = day
    expect(
      dayStateAt(noClose, closeOf(WibDate.make("2026-11-06")))
    ).toMatchObject({ previousClose: 8_950, change: -75 })
  })
})
