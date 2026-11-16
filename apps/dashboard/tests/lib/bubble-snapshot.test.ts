import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { snapshotCaption, snapshotName } from "@/lib/bubble-snapshot"

// 10:00:05 WIB, Monday 16 November 2026; 23:59:59 WIB the day before.
const MORNING = Date.parse("2026-11-16T03:00:05Z")
const LATE = Date.parse("2026-11-15T16:59:59Z")

describe("a snapshot", () => {
  it.effect("is named for its date and time in WIB", () =>
    Effect.gen(function* () {
      expect(yield* snapshotName(MORNING)).toBe(
        "market-bubbles-20261116-100005.png"
      )
      expect(yield* snapshotName(LATE)).toBe(
        "market-bubbles-20261115-235959.png"
      )
    })
  )

  it.effect(
    "is captioned with the date and time in WIB, the window, both metrics and the filter",
    () =>
      Effect.gen(function* () {
        expect(
          yield* snapshotCaption(
            { size: "value", colour: "delta", window: "5m", top: 100 },
            MORNING
          )
        ).toEqual([
          "Market Bubbles",
          "Mon, 16 Nov 2026 · 10:00:05 WIB",
          "Window 5m",
          "Size Value",
          "Colour Buy/Sell delta %",
          "Top 100",
        ])
        expect(
          yield* snapshotCaption(
            { size: "freq", colour: "change", window: "D", top: "all" },
            LATE
          )
        ).toEqual([
          "Market Bubbles",
          "Sun, 15 Nov 2026 · 23:59:59 WIB",
          "Window D",
          "Size Frequency",
          "Colour Price change %",
          "All codes",
        ])
      })
  )

  it.effect("names the sector its filter shows", () =>
    Effect.gen(function* () {
      const caption = yield* snapshotCaption(
        {
          size: "value",
          colour: "delta",
          window: "5m",
          top: 50,
          sector: "Financials",
        },
        MORNING
      )
      expect(caption.at(-1)).toBe("Top 50 · Financials")
    })
  )
})
