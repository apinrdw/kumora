import { describe, expect, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { holderMapView } from "@/lib/holder-map"
import type { HolderMapLink, HolderMapRead } from "@/server/holdings/holder-map"

const link = (
  band: HolderMapLink["band"],
  name: string,
  hundredths: number
): HolderMapLink => ({
  code: StockCode.make("TRUE"),
  band,
  holder: name,
  name,
  percentageHundredths: hundredths,
  shares: hundredths * 1000,
  origin: "local",
  investorType: "CP",
})

const read = (links: ReadonlyArray<HolderMapLink>): HolderMapRead => ({
  day: WibDate.make("2026-11-20"),
  month: WibDate.make("2026-10-30"),
  focus: { kind: "stock", code: StockCode.make("TRUE"), issuerName: "TRUE" },
  links,
  mostHeld: [],
})

describe("holderMapView", () => {
  it.effect(
    "splits the links into the 5% band then the 1% band, each dated by its report",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView(
          read([
            link("1%", "C", 200),
            link("5%", "A", 900),
            link("1%", "D", 150),
          ])
        )
        const [above5, above1] = view.focus?.bands ?? []
        expect(above5?.date).toBe("2026-11-20")
        expect(above5?.holders.map(({ name }) => name)).toEqual(["A"])
        expect(above5?.totalHundredths).toBe(900)
        expect(above1?.date).toBe("2026-10-30")
        expect(above1?.holders.map(({ name }) => name)).toEqual(["C", "D"])
        expect(above1?.totalHundredths).toBe(350)
      })
  )

  it.effect("lists most % first, then by name", () =>
    Effect.gen(function* () {
      const view = yield* holderMapView(
        read([link("5%", "B", 600), link("5%", "Z", 700), link("5%", "A", 600)])
      )
      expect(view.focus?.bands[0].holders.map(({ name }) => name)).toEqual([
        "Z",
        "A",
        "B",
      ])
    })
  )

  it.effect("has empty bands for a focus with no holders", () =>
    Effect.gen(function* () {
      const view = yield* holderMapView(read([]))
      expect(
        view.focus?.bands.map(({ holders, totalHundredths }) => [
          holders.length,
          totalHundredths,
        ])
      ).toEqual([
        [0, 0],
        [0, 0],
      ])
    })
  )

  it.effect("has no focus on the landing view, only the stocks most held", () =>
    Effect.gen(function* () {
      const mostHeld = [
        { code: StockCode.make("FLMC"), issuerName: "FLMC", holders: 13 },
      ]
      const view = yield* holderMapView({
        ...read([]),
        focus: undefined,
        mostHeld,
      })
      expect(view.focus).toBeUndefined()
      expect(view.mostHeld).toEqual(mostHeld)
    })
  )
})
