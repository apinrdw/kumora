import { describe, expect, it } from "@effect/vitest"
import {
  StockCode,
  WibDate,
  type RecordedBubbles,
  type RecordedDay,
} from "@workspace/relay"
import { Effect } from "effect"

import { applyBubbles, makeMarketFlow } from "@/lib/bubbles"
import { ihsgChange, marketStrip } from "@/lib/market-strip"

const T0 = Date.parse("2026-11-16T03:00:00Z")

// A code that traded one minute: `value` Rp in `frequency` trades, last at
// `last`.
const traded = (
  code: string,
  value: number,
  frequency: number,
  last: number,
  previousClose?: number
): RecordedBubbles["codes"][number] => ({
  code: StockCode.make(code),
  ...(previousClose === undefined ? {} : { previousClose }),
  day: [value, value / (last * 100), frequency, 0, 0, last],
  minutes: [[T0, value, value / (last * 100), frequency, 0, 0, last]],
})

describe("the header strip's market figures", () => {
  it.effect(
    "sums the day's value and frequency over every code, and counts each code against its previous close",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeMarketFlow()
        yield* applyBubbles(flow, {
          codes: [
            traded("BBCA", 5e9, 120, 9_300, 9_250),
            traded("BBRI", 2e9, 80, 4_100, 4_150),
            traded("TLKM", 1e9, 30, 3_000, 3_000),
            traded("GOTO", 4e8, 900, 70, 68),
            // No previous close known: in the sums, not in the counts.
            traded("NEWS", 1e8, 10, 500),
          ],
        })
        expect(yield* marketStrip(flow)).toEqual({
          value: 8.5e9,
          frequency: 1_140,
          up: 2,
          down: 1,
          unchanged: 1,
        })
      })
  )

  it.effect("is all zeros before the day's first trade", () =>
    Effect.gen(function* () {
      const flow = yield* makeMarketFlow()
      expect(yield* marketStrip(flow)).toEqual({
        value: 0,
        frequency: 0,
        up: 0,
        down: 0,
        unchanged: 0,
      })
    })
  )
})

const day = (date: string, close?: number): RecordedDay => ({
  day: WibDate.make(date),
  ...(close === undefined
    ? {}
    : { ihsg: { close, change: 0, changePercent: 0 } }),
  trades: 1,
  gap: false,
})

describe("IHSG's change", () => {
  const today = WibDate.make("2026-11-16")

  it.effect("is against the last sealed day's IHSG close", () =>
    Effect.gen(function* () {
      const days = [day("2026-11-13", 7_000), day("2026-11-12", 7_500)]
      expect(yield* ihsgChange(7_070, days, today)).toBeCloseTo(1)
    })
  )

  it.effect(
    "skips a sealed day that recorded no IHSG close, and never compares with today",
    () =>
      Effect.gen(function* () {
        const days = [
          day("2026-11-16", 9_999),
          day("2026-11-13"),
          day("2026-11-12", 7_000),
        ]
        expect(yield* ihsgChange(6_930, days, today)).toBeCloseTo(-1)
      })
  )

  it.effect("is unknown with no sealed day to compare with", () =>
    Effect.gen(function* () {
      expect(yield* ihsgChange(7_000, [], today)).toBeUndefined()
    })
  )
})
