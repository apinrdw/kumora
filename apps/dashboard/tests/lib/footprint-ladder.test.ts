import { StockCode, type Candle, type Footprint } from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import { footprintColumns } from "@/lib/footprint"
import { footprintLadder } from "@/lib/footprint-ladder"

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

describe("the hover ladder", () => {
  it.effect(
    "lists each price's exact sell and buy, highest first, the pointer's price highlighted and no-side lots as +n, then exact Vol, Δ and CVD",
    () =>
      Effect.gen(function* () {
        const [column] = yield* footprintColumns(
          [candle],
          [footprint],
          Number.POSITIVE_INFINITY
        )
        const ladder = yield* footprintLadder(column!, 23_281)
        expect(ladder.title).toBe("09:01 WIB · Sell × Buy")
        expect(
          ladder.rows.map((row) => [
            row.sell,
            row.price,
            row.buy,
            row.none,
            row.here,
          ])
        ).toEqual([
          ["3", "23,300", "7", "", false],
          ["0", "23,275", "2,600", "+50", true],
          ["12,345", "23,250", "6", "", false],
        ])
        expect(ladder.totals).toEqual([
          ["Vol", "15,011", "flat"],
          ["Δ", "−9,735", "down"],
          ["CVD", "−9,735", "down"],
        ])
      })
  )
})
