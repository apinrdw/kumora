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
  move: undefined,
  gap: false,
  crossing: undefined,
})

const read = (links: ReadonlyArray<HolderMapLink>): HolderMapRead => ({
  day: WibDate.make("2026-11-20"),
  month: WibDate.make("2026-10-30"),
  refused: undefined,
  days: [WibDate.make("2026-11-20")],
  focus: { kind: "stock", code: StockCode.make("TRUE"), issuerName: "TRUE" },
  links,
  offList: [],
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
      expect(view.focus?.bands[0]?.holders.map(({ name }) => name)).toEqual([
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

  it.effect(
    "shows each holder's crossing of 5% over its move, else its move, else Unchanged",
    () =>
      Effect.gen(function* () {
        const moved = (kind: "new" | "down") => ({
          kind,
          shareChange: -1000,
          percentageChange: -10,
        })
        const view = yield* holderMapView(
          read([
            { ...link("5%", "A", 900), move: moved("new") },
            {
              ...link("5%", "B", 800),
              move: moved("new"),
              crossing: { kind: "up into 5%", monthHundredths: 450 },
            },
            link("5%", "C", 700),
            {
              ...link("1%", "D", 600),
              move: moved("down"),
              crossing: {
                kind: "down out of 5%",
                since: WibDate.make("2026-11-20"),
              },
            },
            { ...link("1%", "E", 200), move: moved("down") },
          ])
        )
        expect(
          view.focus?.bands.flatMap(({ holders }) =>
            holders.map(({ name, shownMove }) => [name, shownMove])
          )
        ).toEqual([
          ["A", "new"],
          ["B", "up into 5%"],
          ["C", "unchanged"],
          ["D", "down out of 5%"],
          ["E", "down"],
        ])
      })
  )

  it.effect("lists Off list holders latest to leave first, then by name", () =>
    Effect.gen(function* () {
      const off = (
        band: HolderMapLink["band"],
        name: string,
        since: string
      ) => ({
        code: StockCode.make("TRUE"),
        band,
        holder: name,
        name,
        since: WibDate.make(since),
        percentageHundredths: 300,
      })
      const view = yield* holderMapView({
        ...read([]),
        offList: [
          off("1%", "B", "2026-08-31"),
          off("5%", "C", "2026-11-19"),
          off("1%", "A", "2026-08-31"),
        ],
      })
      expect(view.focus?.offList.map(({ name }) => name)).toEqual([
        "C",
        "A",
        "B",
      ])
    })
  )

  it.effect(
    "draws the focus stock linked to each holder the side panel lists, one node each",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView(
          read([
            link("1%", "C", 200),
            link("5%", "A", 900),
            link("1%", "D", 150),
          ])
        )
        const graph = view.focus?.graph
        expect(
          graph?.nodes.map(({ kind, name, band }) => [kind, name, band])
        ).toEqual([
          ["stock", "TRUE", undefined],
          ["holder", "A", "5%"],
          ["holder", "C", "1%"],
          ["holder", "D", "1%"],
        ])
        expect(
          graph?.links.map(({ source, target, band }) => [source, target, band])
        ).toEqual([
          ["stock:TRUE", "holder:A", "5%"],
          ["stock:TRUE", "holder:C", "1%"],
          ["stock:TRUE", "holder:D", "1%"],
        ])
      })
  )

  it.effect("sizes a holder's node and link by its stake", () =>
    Effect.gen(function* () {
      const view = yield* holderMapView(
        read([link("5%", "A", 5283), link("1%", "B", 142)])
      )
      const [, big, small] = view.focus?.graph.nodes ?? []
      const [bigLink, smallLink] = view.focus?.graph.links ?? []
      expect(big?.radius).toBeGreaterThan(small?.radius ?? Infinity)
      expect(bigLink?.width).toBeGreaterThan(smallLink?.width ?? Infinity)
    })
  )

  it.effect(
    "marks the focus, labels it and its holders, and refocuses only on a stock",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView(read([link("5%", "A", 900)]))
        const [stock, holder] = view.focus?.graph.nodes ?? []
        expect(stock).toMatchObject({
          focus: true,
          labelled: true,
          refocus: { stock: "TRUE" },
        })
        expect(holder).toMatchObject({
          focus: false,
          labelled: true,
          refocus: undefined,
        })
      })
  )

  it.effect("shortens a long holder name for its label", () =>
    Effect.gen(function* () {
      const name =
        "DJS HARI TUA BADAN PENYELENGGARA JAMINAN SOSIAL KETENAGAKERJAAN"
      const view = yield* holderMapView(read([link("1%", name, 200)]))
      const holder = view.focus?.graph.nodes[1]
      expect(holder?.name).toBe(name)
      expect(holder?.label).toBe("DJS HARI TUA BADAN PENYELENG…")
    })
  )

  it.effect(
    "names in the legend each node kind, band and origin the map draws",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView(
          read([
            link("5%", "A", 900),
            { ...link("1%", "B", 200), origin: "foreign" },
            { ...link("1%", "C", 150), origin: undefined },
          ])
        )
        expect(view.focus?.legend.map(({ label }) => label)).toEqual([
          "Stock",
          "Holder",
          "5% and above",
          "1% to 5%",
          "Local",
          "Foreign",
          "Origin unknown",
        ])
        const only5 = yield* holderMapView(read([link("5%", "A", 900)]))
        expect(only5.focus?.legend.map(({ label }) => label)).toEqual([
          "Stock",
          "Holder",
          "5% and above",
          "Local",
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
