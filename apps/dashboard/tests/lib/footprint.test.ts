import { StockCode, type Candle, type Footprint } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  drawMode,
  footerLabelled,
  footprintColumns,
  footprintSummary,
  idxTick,
  minuteTotals,
  shortLots,
  windowOfLast,
} from "@/lib/footprint"

const footprint = (
  wib: string,
  cells: ReadonlyArray<readonly [number, number, number, number]>
): Footprint => ({
  code: StockCode.make("UNTR"),
  minute: DateTime.makeUnsafe(`2026-11-09T${wib}:00+07:00`),
  cells: cells.map(([price, sell, buy, none]) => ({ price, sell, buy, none })),
})

describe("lots on the footprint", () => {
  it.effect(
    "stay exact under 1,000 and keep 2 decimals from there, K, M then B",
    () =>
      Effect.gen(function* () {
        const shown = yield* Effect.forEach(
          [0, 7, 999, 1_000, 1_500, 12_345, 999_994, 999_995, 1_210_000, 2.5e9],
          shortLots
        )
        expect(shown).toEqual([
          "0",
          "7",
          "999",
          "1.00K",
          "1.50K",
          "12.35K",
          "999.99K",
          // Would round to 1,000.00K.
          "1.00M",
          "1.21M",
          "2.50B",
        ])
        expect(yield* shortLots(-1_500)).toBe("-1.50K")
      })
  )
})

describe("the IDX tick", () => {
  it.effect("is 1 below Rp200, then 2, 5, 10 and 25 by price band", () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.forEach(
          [50, 199, 200, 498, 500, 1_995, 2_000, 4_990, 5_000, 23_300],
          idxTick
        )
      ).toEqual([1, 1, 2, 2, 5, 5, 10, 10, 25, 25])
    })
  )
})

describe("each minute's Vol, Δ and CVD", () => {
  it.effect(
    "count no-side lots in Vol only, and run CVD over the day's minutes",
    () =>
      Effect.gen(function* () {
        const totals = yield* minuteTotals([
          // The opening match: no aggressor side.
          footprint("08:58", [[23200, 0, 0, 54]]),
          footprint("09:00", [
            [23150, 1, 4, 0],
            [23300, 0, 2, 0],
          ]),
          footprint("09:01", [[23275, 9, 0, 1]]),
        ])
        expect(
          totals.map(({ volume, buy, sell, delta, cvd }) => ({
            volume,
            buy,
            sell,
            delta,
            cvd,
          }))
        ).toEqual([
          { volume: 54, buy: 0, sell: 0, delta: 0, cvd: 0 },
          { volume: 7, buy: 6, sell: 1, delta: 5, cvd: 5 },
          { volume: 10, buy: 0, sell: 9, delta: -9, cvd: -4 },
        ])
      })
  )
})

describe("how a footprint minute draws", () => {
  it.effect(
    "text from 56 px a minute, compact from 34, split bars from 9, candles below",
    () =>
      Effect.gen(function* () {
        const at = (spacing: number) => drawMode(spacing, 36)
        expect(
          yield* Effect.forEach([80, 56, 55.9, 34, 33.9, 9, 8.9, 3], at)
        ).toEqual([
          "text",
          "text",
          "compact",
          "compact",
          "bars",
          "bars",
          "candles",
          "candles",
        ])
      })
  )

  it.effect(
    "rows too short for a 6 px font draw bars, too short for a pixel, candles",
    () =>
      Effect.gen(function* () {
        expect(yield* drawMode(80, 6.9)).toBe("bars")
        expect(yield* drawMode(80, 1.9)).toBe("candles")
      })
  )

  it.effect("labels the footer's cells from 76 px a minute", () =>
    Effect.gen(function* () {
      expect(yield* footerLabelled(76)).toBe(true)
      expect(yield* footerLabelled(75.9)).toBe(false)
    })
  )
})

describe("the window of the last minutes", () => {
  it.effect(
    "shows exactly 10 whole minutes: a range 9 wide ending on the last bar",
    () =>
      Effect.gen(function* () {
        expect(yield* windowOfLast(30, 10)).toEqual({ from: 20, to: 29 })
        // Fewer bars than the window: it still spans 10, ending on the last.
        expect(yield* windowOfLast(3, 10)).toEqual({ from: -7, to: 2 })
      })
  )
})

describe("chart 2's columns", () => {
  const candle = (wib: string, close: number): Candle => ({
    code: StockCode.make("UNTR"),
    minute: DateTime.makeUnsafe(`2026-11-09T${wib}:00+07:00`),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    value: close * 100,
    frequency: 1,
  })

  it.effect(
    "write each row's lots and the footer's signed Δ and CVD, and grey the minutes after the cursor",
    () =>
      Effect.gen(function* () {
        const columns = yield* footprintColumns(
          [candle("09:00", 23150), candle("09:01", 23275)],
          [
            footprint("09:00", [[23150, 1_500, 4, 0]]),
            footprint("09:01", [[23275, 0, 2, 0]]),
          ],
          DateTime.toEpochMillis(
            DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
          )
        )
        expect(
          columns.map((column) => ({
            later: column.later,
            rows: column.rows.map((row) => [
              row.half,
              row.sellText,
              row.buyText,
            ]),
            footer: [column.volumeText, column.deltaText, column.cvdText],
          }))
        ).toEqual([
          {
            later: false,
            rows: [[12.5, "1.50K", "4"]],
            footer: ["1.50K", "−1.50K", "−1.50K"],
          },
          {
            later: true,
            rows: [[12.5, "0", "2"]],
            footer: ["2", "+2", "−1.49K"],
          },
        ])
      })
  )
})

describe("chart 2 in words", () => {
  it.effect(
    "counts the minutes up to the cursor's and gives the latest one's exact Vol, Δ and CVD",
    () =>
      Effect.gen(function* () {
        const footprints = [
          footprint("09:00", [[23150, 1_500, 4, 0]]),
          footprint("09:01", [[23275, 0, 2, 3]]),
        ]
        expect(
          yield* footprintSummary(footprints, Number.POSITIVE_INFINITY)
        ).toBe("Footprint minutes: 2. 09:01:00: Vol 5, Δ +2, CVD −1,494")
        expect(
          yield* footprintSummary(
            footprints,
            DateTime.toEpochMillis(
              DateTime.makeUnsafe("2026-11-09T09:00:30+07:00")
            )
          )
        ).toBe(
          "Footprint minutes: 1. 09:00:00: Vol 1,504, Δ −1,496, CVD −1,496"
        )
      })
  )
})
