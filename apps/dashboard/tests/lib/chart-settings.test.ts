import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  CHART_SETTINGS_DEFAULT,
  parseChartSettings,
} from "@/lib/chart-settings"

describe("the remembered chart settings", () => {
  it.effect("open on the defaults with nothing stored", () =>
    Effect.gen(function* () {
      expect(yield* parseChartSettings(null)).toEqual({
        topN: 25,
        mode: "stacked",
        imbalance: 3,
        poc: true,
        vwap: true,
      })
      expect(CHART_SETTINGS_DEFAULT).toEqual(yield* parseChartSettings(null))
    })
  )

  it.effect("read back what was stored", () =>
    Effect.gen(function* () {
      const stored = {
        topN: 10,
        mode: "profile",
        imbalance: 0,
        poc: false,
        vwap: false,
      }
      expect(yield* parseChartSettings(JSON.stringify(stored))).toEqual(stored)
      expect(
        (yield* parseChartSettings(JSON.stringify({ ...stored, topN: 1 }))).topN
      ).toBe(1)
    })
  )

  it.effect(
    "keep each stored setting that parses and default the rest, broken text included",
    () =>
      Effect.gen(function* () {
        expect(
          yield* parseChartSettings(
            JSON.stringify({
              topN: 33,
              mode: "side",
              imbalance: 7,
              poc: "no",
              vwap: false,
            })
          )
        ).toEqual({
          topN: 25,
          mode: "side",
          imbalance: 3,
          poc: true,
          vwap: false,
        })
        expect(yield* parseChartSettings("{not json")).toEqual(
          CHART_SETTINGS_DEFAULT
        )
        expect(yield* parseChartSettings("[1,2]")).toEqual(
          CHART_SETTINGS_DEFAULT
        )
      })
  )
})
