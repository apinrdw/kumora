import { describe, expect, it } from "@effect/vitest"
import type { SectorName, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { panelBubbles, panelSetOf } from "@/lib/bubble-panel"
import type { BubbleFigures } from "@/lib/bubbles"

const bubble = (code: string, size: number): BubbleFigures => ({
  code: code as StockCode,
  value: size,
  volume: 0,
  frequency: 1,
  buyValue: 0,
  sellValue: 0,
  buySellDelta: 0,
  change: undefined,
  dayChange: undefined,
  last: 100,
  size,
})

const codes = (bubbles: ReadonlyArray<BubbleFigures>) =>
  bubbles.map(({ code }) => code)

// Ranked largest first, as bubblesOf hands them over.
const RANKED = [
  bubble("BBCA", 900),
  bubble("ADRO", 800),
  bubble("BBRI", 700),
  bubble("AADI", 600),
  bubble("TLKM", 500),
]

const SECTORS: ReadonlyMap<StockCode, SectorName> = new Map([
  ["BBCA" as StockCode, "Financials"],
  ["BBRI" as StockCode, "Financials"],
  ["ADRO" as StockCode, "Energy"],
  ["AADI" as StockCode, "Energy"],
])

const around = {
  selected: "BBCA" as StockCode,
  watchlist: ["TLKM", "ADRO", "GOTO"].map((code) => code as StockCode),
  sectors: SECTORS,
}

describe("the Market Live bubble panel's codes", () => {
  it.effect("Market top keeps the market's largest, at most 60", () =>
    Effect.gen(function* () {
      expect(codes(yield* panelBubbles(RANKED, "top", around))).toEqual([
        "BBCA",
        "ADRO",
        "BBRI",
        "AADI",
        "TLKM",
      ])
      const many = Array.from({ length: 90 }, (_, i) =>
        bubble(`C${String(i).padStart(3, "0")}`, 1000 - i)
      )
      const shown = yield* panelBubbles(many, "top", around)
      expect(shown).toHaveLength(60)
      expect(shown.at(-1)?.code).toBe("C059")
    })
  )

  it.effect("Watchlist keeps the watchlist's traded codes, largest first", () =>
    Effect.gen(function* () {
      expect(codes(yield* panelBubbles(RANKED, "watchlist", around))).toEqual([
        "ADRO",
        "TLKM",
      ])
    })
  )

  it.effect("Sector of selected keeps the selected code's sector", () =>
    Effect.gen(function* () {
      expect(codes(yield* panelBubbles(RANKED, "sector", around))).toEqual([
        "BBCA",
        "BBRI",
      ])
      expect(
        codes(
          yield* panelBubbles(RANKED, "sector", {
            ...around,
            selected: "TLKM" as StockCode,
          })
        )
      ).toEqual(["TLKM"])
    })
  )

  it.effect(
    "Sector of selected shows the market top while an index is selected",
    () =>
      Effect.gen(function* () {
        expect(yield* panelSetOf("sector", "IHSG" as StockCode)).toBe("top")
        expect(yield* panelSetOf("sector", "BBCA" as StockCode)).toBe("sector")
        expect(yield* panelSetOf("watchlist", "IHSG" as StockCode)).toBe(
          "watchlist"
        )
      })
  )
})
