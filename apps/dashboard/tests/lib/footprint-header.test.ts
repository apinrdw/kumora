import { StockCode, type Candle, type Footprint } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { footprintColumns } from "@/lib/footprint"
import { footprintHeader, type HeaderLine } from "@/lib/footprint-header"

const minute = DateTime.makeUnsafe("2026-11-09T09:01:00+07:00")
const candle: Candle = {
  code: StockCode.make("UNTR"),
  minute,
  open: 23_250,
  high: 23_300,
  low: 23_250,
  close: 23_300,
  volume: 15_011,
  value: 0,
  frequency: 9,
}
const footprint: Footprint = {
  code: StockCode.make("UNTR"),
  minute,
  cells: [
    { price: 23_250, sell: 12_345, buy: 6, none: 0 },
    { price: 23_275, sell: 0, buy: 2_600, none: 50 },
    { price: 23_300, sell: 3, buy: 7, none: 0 },
  ],
}

const read = (lines: ReadonlyArray<HeaderLine>) =>
  lines.map((line) => line.map((part) => [part.text, part.tone]))

describe("the footprint chart's header", () => {
  it.effect(
    "reads the minute's time, OHLC, lots and fills, Buy, Sell, Δ and CVD, then the VWAP, its bands and the POC",
    () =>
      Effect.gen(function* () {
        const [column] = yield* footprintColumns(
          [candle],
          [footprint],
          Number.POSITIVE_INFINITY
        )
        expect(read(yield* footprintHeader(column!))).toEqual([
          [
            ["09:01", "flat"],
            ["O 23,250", "flat"],
            ["H 23,300", "flat"],
            ["L 23,250", "flat"],
            ["C 23,300", "up"],
            ["15,011 lots, 9 fills", "flat"],
            ["Buy 2,613", "up"],
            ["Sell 12,348", "down"],
            ["Δ −9,735", "down"],
            ["CVD −9,735", "down"],
          ],
          [
            ["VWAP 23,254.4", "vwap"],
            ["±1σ 9.6", "band1"],
            ["±2σ 19.2", "band2"],
            ["±3σ 28.8", "band3"],
            ["POC 23,250", "flat"],
          ],
        ])
      })
  )

  it.effect("says only the time of a minute after the cursor", () =>
    Effect.gen(function* () {
      const [column] = yield* footprintColumns([candle], [footprint], 0)
      expect(read(yield* footprintHeader(column!))).toEqual([
        [["09:01 after the cursor", "flat"]],
      ])
    })
  )

  it.effect("dashes the VWAP and POC of a minute with no lots yet", () =>
    Effect.gen(function* () {
      const [column] = yield* footprintColumns(
        [candle],
        [],
        Number.POSITIVE_INFINITY
      )
      expect(read(yield* footprintHeader(column!))[1]).toEqual([
        ["VWAP —", "vwap"],
        ["±1σ —", "band1"],
        ["±2σ —", "band2"],
        ["±3σ —", "band3"],
        ["POC —", "flat"],
      ])
    })
  )
})
