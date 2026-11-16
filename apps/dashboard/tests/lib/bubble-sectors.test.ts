import { describe, expect, it } from "@effect/vitest"
import type { SectorName, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import {
  inSector,
  packSectors,
  sectorGroups,
  sectorLookup,
  type SectorCircle,
} from "@/lib/bubble-sectors"
import type { BubbleFigures } from "@/lib/bubbles"

const bubble = (
  code: string,
  size: number,
  sides: { buy?: number; sell?: number; change?: number } = {}
): BubbleFigures => ({
  code: code as StockCode,
  value: size,
  volume: 0,
  frequency: 1,
  buyValue: sides.buy ?? 0,
  sellValue: sides.sell ?? 0,
  delta: 0,
  change: sides.change,
  dayChange: undefined,
  last: 100,
  size,
})

const LOOKUP = Effect.runSync(
  sectorLookup({
    fetchedAt: "2026-11-16T15:00:00.000Z",
    sectors: {
      ["AADI" as StockCode]: { sector: "Energy", industry: "Coal" },
      ["ADRO" as StockCode]: { sector: "Energy", industry: "Coal" },
      ["BBCA" as StockCode]: { sector: "Financials", industry: "Banks" },
    },
  })
)

// Every pair apart by at least the sum of their radii.
const overlaps = (circles: ReadonlyArray<SectorCircle>) => {
  const found: Array<string> = []
  for (let i = 0; i < circles.length; i++)
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i]!
      const b = circles[j]!
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 1e-6)
        found.push(`${a.sector} × ${b.sector}`)
    }
  return found
}

// A small seeded generator, so a failing case can be rerun.
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}

const SECTORS: ReadonlyArray<SectorName> = [
  "Energy",
  "Basic Materials",
  "Industrials",
  "Consumer Non-Cyclicals",
  "Consumer Cyclicals",
  "Healthcare",
  "Financials",
  "Properties & Real Estate",
  "Technology",
  "Infrastructures",
  "Transportation & Logistic",
  "Unclassified",
]

describe("the sector filter", () => {
  it.effect("keeps one sector's codes of the ranked bubbles", () =>
    Effect.gen(function* () {
      const ranked = [bubble("BBCA", 9), bubble("AADI", 5), bubble("NEWX", 3)]
      expect(
        (yield* inSector(ranked, LOOKUP, "Energy")).map((b) => b.code)
      ).toEqual(["AADI"])
      // A code the map leaves out is Unclassified.
      expect(
        (yield* inSector(ranked, LOOKUP, "Unclassified")).map((b) => b.code)
      ).toEqual(["NEWX"])
      expect(yield* inSector(ranked, LOOKUP, undefined)).toBe(ranked)
    })
  )
})

describe("the sector groups", () => {
  it.effect(
    "sum each sector's size, its Buy/Sell delta % and its change %, largest first",
    () =>
      Effect.gen(function* () {
        const groups = yield* sectorGroups(
          [
            bubble("BBCA", 50, { buy: 10, sell: 30, change: 1 }),
            bubble("AADI", 60, { buy: 30, sell: 10, change: 2 }),
            bubble("ADRO", 20, { buy: 10, sell: 0, change: -2 }),
            bubble("NEWX", 5),
          ],
          LOOKUP
        )
        expect(groups).toEqual([
          // (40 − 10) / 50; change weighted by size: (60·2 + 20·−2) / 80.
          { sector: "Energy", total: 80, delta: 60, change: 1, codes: 2 },
          { sector: "Financials", total: 50, delta: -50, change: 1, codes: 1 },
          // No sides and no change known.
          {
            sector: "Unclassified",
            total: 5,
            delta: 0,
            change: undefined,
            codes: 1,
          },
        ])
      })
  )
})

describe("the sector pack", () => {
  it.effect(
    "sizes each sector's circle from its bubbles' area × 1.5, plus 18 px",
    () =>
      Effect.gen(function* () {
        const [circle] = yield* packSectors(
          [{ sector: "Energy", area: Math.PI * 100 }],
          800,
          600
        )
        expect(circle!.r).toBeCloseTo(Math.sqrt(150) + 18)
        // One sector sits at the centre.
        expect(circle!.x).toBeCloseTo(400)
        expect(circle!.y).toBeCloseTo(300)
      })
  )

  it.effect("never overlaps two sectors, on any canvas", () =>
    Effect.gen(function* () {
      const next = random(7)
      for (let run = 0; run < 200; run++) {
        const count = 1 + Math.floor(next() * SECTORS.length)
        const width = 300 + next() * 1500
        const height = 200 + next() * 900
        const areas = SECTORS.slice(0, count).map((sector) => ({
          sector,
          // From a lone small code to a sector filling the canvas.
          area: width * height * 0.34 * next() ** 3,
        }))
        const first = yield* packSectors(areas, width, height)
        expect(overlaps(first), `run ${run}`).toEqual([])
        // Repacked from where the last pack put them, as each recompute is.
        const grown = areas.map(({ sector, area }) => ({
          sector,
          area: area * (0.5 + next()),
        }))
        const previous = new Map(first.map((c) => [c.sector, c] as const))
        expect(
          overlaps(yield* packSectors(grown, width, height, previous)),
          `run ${run} repacked`
        ).toEqual([])
      }
    })
  )

  it.effect("puts the largest sector nearest the centre", () =>
    Effect.gen(function* () {
      const circles = yield* packSectors(
        [
          { sector: "Energy", area: 4000 },
          { sector: "Financials", area: 40_000 },
          { sector: "Technology", area: 9000 },
          { sector: "Healthcare", area: 2000 },
        ],
        1200,
        800
      )
      const fromCentre = (c: SectorCircle) => Math.hypot(c.x - 600, c.y - 400)
      const nearest = [...circles].sort((a, b) => fromCentre(a) - fromCentre(b))
      expect(nearest[0]!.sector).toBe("Financials")
    })
  )
})
