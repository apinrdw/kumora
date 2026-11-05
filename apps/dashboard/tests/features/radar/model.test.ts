import { describe, expect, test } from "vitest"

import { CANDIDATES } from "@/features/radar/data"
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  matches,
  parseRadarSearch,
  toRow,
} from "@/features/radar/model"
import type { Filters } from "@/features/radar/model"

const passing = (patch: Partial<Filters>) =>
  CANDIDATES.filter((c) => matches(c, { ...DEFAULT_FILTERS, ...patch })).map(
    (c) => c.symbol
  )

describe("matches", () => {
  test("the default filters pass every candidate", () => {
    expect(passing({})).toEqual([
      "BBCA",
      "ANTM",
      "TLKM",
      "ASII",
      "BMRI",
      "MDKA",
    ])
  })

  test("a confidence band keeps candidates at or above it and drops unscored ones", () => {
    expect(passing({ confidence: "70" })).toEqual(["BBCA", "ANTM"])
    expect(passing({ confidence: "50" })).toEqual([
      "BBCA",
      "ANTM",
      "TLKM",
      "ASII",
      "BMRI",
    ])
  })

  test("sector, regime and liquidity each narrow to their value", () => {
    expect(passing({ sector: "Keuangan" })).toEqual(["BBCA", "BMRI"])
    expect(passing({ regime: "distribution" })).toEqual(["TLKM"])
    expect(passing({ liquidOnly: true })).not.toContain("MDKA")
    expect(passing({ liquidOnly: true })).toHaveLength(5)
  })

  test("the volume anomaly keeps volume at least twice the average", () => {
    expect(passing({ volumeAnomaly: true })).toEqual(["BBCA", "ANTM", "MDKA"])
  })

  test("filters combine", () => {
    expect(
      passing({ sector: "Logam", volumeAnomaly: true, liquidOnly: true })
    ).toEqual(["ANTM"])
    expect(passing({ sector: "Energi" })).toEqual([])
  })
})

describe("activeFilterCount", () => {
  test("counts each narrowing filter but never the timeframe", () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0)
    expect(activeFilterCount({ ...DEFAULT_FILTERS, timeframe: "1M" })).toBe(0)
    expect(
      activeFilterCount({
        timeframe: "1D",
        confidence: "70",
        sector: "Logam",
        regime: "mixed",
        liquidOnly: true,
        volumeAnomaly: true,
      })
    ).toBe(5)
  })
})

describe("parseRadarSearch", () => {
  test("keeps a known symbol in any case and drops any other key", () => {
    expect(parseRadarSearch({ t: "bbca", mode: "watchlist" })).toEqual({
      t: "BBCA",
    })
  })

  test("keeps a well-formed symbol it cannot know about", () => {
    expect(parseRadarSearch({ t: "zzzz" }).t).toBe("ZZZZ")
  })

  test("drops malformed or non-string values to undefined", () => {
    expect(parseRadarSearch({ t: "ZZ" })).toEqual({ t: undefined })
    expect(parseRadarSearch({ t: 42 })).toEqual({ t: undefined })
  })
})

describe("toRow", () => {
  test("resolves the change for the chosen timeframe", () => {
    const bbca = CANDIDATES[0]
    expect(toRow(bbca, "1D")).toMatchObject({ symbol: "BBCA", change: 1.35 })
    expect(toRow(bbca, "1M").change).not.toBe(1.35)
  })
})
