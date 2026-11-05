import { describe, expect, test } from "vitest"

import { IsoDateTime } from "@/domain/time"
import type { Wall } from "@/domain/trade"
import {
  money,
  sweepLine,
  thresholdLine,
  wallState,
  whaleLogEntries,
} from "@/features/radar/whale-format"

import { enrgSweep, noWhales } from "../../support/whales"

const wall: Wall = {
  day: "2026-10-29",
  symbol: enrgSweep.symbol,
  side: "offer",
  price: 5050,
  firstOrderNumber: "202610290002329192",
  memberOrderNumbers: ["202610290002329192"],
  hitsSeen: 95,
  lotsMatched: 1429,
  threshold: 696,
  warmingUp: true,
  prior: "market",
  firstSeen: IsoDateTime.make("2026-10-29T06:31:19.000Z"),
  lastSeen: IsoDateTime.make("2026-10-29T06:33:55.000Z"),
  closedAt: null,
  closedBy: null,
  seq: 1,
}

describe("sweepLine", () => {
  test("reads as agreed, with colons in the time", () => {
    expect(sweepLine(enrgSweep)).toBe(
      "13:42:35  ENRG  RG  Sweep buy  48.766 at 665  3,24B  198 freq"
    )
  })

  test("a range is low–high", () => {
    expect(
      sweepLine({ ...enrgSweep, side: "sell", priceLow: 660, priceHigh: 1665 })
    ).toContain("Sweep sell  48.766 at 660–1.665")
  })

  test("under a billion it reads in millions", () => {
    expect(money(245_000_000)).toBe("245M")
  })

  test("under a million it reads in thousands, never 0M", () => {
    expect(money(455_000)).toBe("455K")
  })
})

describe("thresholdLine", () => {
  test.each([
    ["own", "own previous session"],
    ["market", "market-wide prior"],
    ["none", "no prior"],
  ] as const)("names the %s prior", (prior, copy) => {
    expect(
      thresholdLine({ ...noWhales.threshold, threshold: 696, prior })
    ).toContain(copy)
  })

  test("a settled threshold does not say warming up", () => {
    expect(
      thresholdLine({
        ...noWhales.threshold,
        threshold: 696,
        warmingUp: false,
        ordersToday: 1200,
      })
    ).toBe("whale threshold 696 lots · 1.200 orders today · no prior")
  })
})

describe("wallState", () => {
  test("says holding, traded through, or no hit", () => {
    expect(wallState(wall)).toBe("holding, last hit 13:33:55")
    expect(
      wallState({
        ...wall,
        closedBy: "traded-through",
        closedAt: IsoDateTime.make("2026-10-29T06:40:00.000Z"),
      })
    ).toBe("gone, traded through 13:40:00")
    expect(
      wallState({
        ...wall,
        closedBy: "idle",
        closedAt: IsoDateTime.make("2026-10-29T06:40:00.000Z"),
      })
    ).toBe("gone, no hit since 13:33:55")
  })
})

describe("whaleLogEntries", () => {
  test("merges sweeps and walls newest first, with ≥ on a wall's counts", () => {
    const entries = whaleLogEntries([enrgSweep], [wall])
    expect(entries.map((e) => e.key)).toEqual([
      "sweep:2026-10-29:ENRG:853413",
      "wall:2026-10-29:ENRG:202610290002329192",
    ])
    expect(entries[1]?.line).toContain("≥95 hits  ≥1.429 lots")
    expect(entries[0]?.tone).toBe("up")
    expect(entries[1]?.tone).toBe("down")
  })
})
