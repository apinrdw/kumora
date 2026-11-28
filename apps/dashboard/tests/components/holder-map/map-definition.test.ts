import { describe, expect, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import {
  mapDefinition,
  printedInside,
  tooltipText,
} from "@/components/holder-map/map-definition"
import type { MapNode } from "@/lib/holder-map-graph"

const holder = (move: MapNode["move"]): MapNode => ({
  id: "holder:PERINTIS",
  kind: "holder",
  issuerName: undefined,
  holding: {
    code: StockCode.make("TRUE"),
    holderName: "PT PERINTIS TRINITI PROPERTI TBK",
  },
  name: "PT PERINTIS TRINITI PROPERTI TBK",
  label: "PT PERINTIS TRINITI PROPERTI…",
  inside: "CP",
  band: "5%",
  origin: "local",
  investorType: "CP",
  stakeHundredths: 1234,
  shares: 1_000_000,
  radius: 10,
  focus: false,
  offList: move?.kind === "off list",
  move,
  labelled: true,
  refocus: undefined,
})

describe("tooltipText", () => {
  it.effect("names a holder's move and its change", () =>
    Effect.gen(function* () {
      const text = yield* tooltipText(
        holder({ kind: "down", percentageChange: -77 })
      )
      expect(text.split("\n")).toEqual([
        "PT PERINTIS TRINITI PROPERTI TBK",
        "12.34% of TRUE",
        "Local · Corporate",
        "Down −0.77%",
      ])
    })
  )

  it.effect("names a crossing of 5%, and Unchanged with no change", () =>
    Effect.gen(function* () {
      const up = yield* tooltipText(
        holder({ kind: "up into 5%", percentageChange: undefined })
      )
      expect(up.split("\n").at(-1)).toBe("Up into 5%")
      const unchanged = yield* tooltipText(
        holder({ kind: "unchanged", percentageChange: undefined })
      )
      expect(unchanged.split("\n").at(-1)).toBe("Unchanged")
    })
  )

  it.effect("names an Off list holder's last % and the period it left", () =>
    Effect.gen(function* () {
      const month = yield* tooltipText({
        ...holder({
          kind: "off list",
          band: "1%",
          since: WibDate.make("2026-09-30"),
        }),
        origin: undefined,
        investorType: undefined,
        stakeHundredths: 300,
      })
      expect(month.split("\n")).toEqual([
        "PT PERINTIS TRINITI PROPERTI TBK",
        "3.00% of TRUE last",
        "Off list since Sep 2026",
      ])
      const day = yield* tooltipText(
        holder({
          kind: "off list",
          band: "5%",
          since: WibDate.make("2026-11-19"),
        })
      )
      expect(day.split("\n").at(-1)).toBe("Off list since 19 Nov 2026")
    })
  )

  it.effect(
    "names a stock with its issuer, and a holder focus's stake in it",
    () =>
      Effect.gen(function* () {
        const stock: MapNode = {
          ...holder({ kind: "up", percentageChange: 28 }),
          id: "stock:TLKM",
          kind: "stock",
          name: "TLKM",
          issuerName: "TELKOM INDONESIA (PERSERO) Tbk",
          holding: {
            code: StockCode.make("TLKM"),
            holderName: "THE BANK OF NEW YORK MELLON",
          },
          stakeHundredths: 652,
        }
        expect((yield* tooltipText(stock)).split("\n")).toEqual([
          "TLKM · TELKOM INDONESIA (PERSERO) Tbk",
          "6.52% held by THE BANK OF NEW YORK MELLON",
          "Up +0.28%",
        ])
        // A stock of the outer ring: no holding of its own.
        expect(
          yield* tooltipText({
            ...stock,
            holding: undefined,
            stakeHundredths: undefined,
            move: undefined,
          })
        ).toBe("TLKM · TELKOM INDONESIA (PERSERO) Tbk")
      })
  )

  it.effect("names a custodian, its broker code and the lots it holds", () =>
    Effect.gen(function* () {
      const custodian: MapNode = {
        ...holder(undefined),
        id: "custodian:YP",
        kind: "custodian",
        name: "MIRAE ASSET SEKURITAS INDONESIA",
        inside: "YP",
        band: undefined,
        origin: undefined,
        investorType: undefined,
        holding: undefined,
        stakeHundredths: undefined,
        shares: 4_525_939_584,
      }
      expect((yield* tooltipText(custodian)).split("\n")).toEqual([
        "MIRAE ASSET SEKURITAS INDONESIA · YP",
        "Custodian of 45,259,395.84 lots in view",
      ])
      expect(
        (yield* tooltipText({ ...custodian, inside: undefined })).split("\n")
      ).toEqual([
        "MIRAE ASSET SEKURITAS INDONESIA",
        "Custodian of 45,259,395.84 lots in view",
      ])
    })
  )
})

describe("printedInside", () => {
  // An outer-ring stock and a holder, at the scale fit-to-view gives a
  // hub's map: 4 layout units a px, so a 12-unit dot is 3 px across.
  const stock: MapNode = {
    ...holder(undefined),
    id: "stock:BSDE",
    kind: "stock",
    name: "BSDE",
    label: "BSDE",
    inside: "BSDE",
    band: undefined,
    radius: 12,
    labelled: false,
  }
  const graph = {
    key: "stock:TRUE@2026-11-20",
    nodes: [stock, { ...holder(undefined), inside: "CP", radius: 5 }],
    links: [],
  }
  const layout = {
    positions: {
      "stock:BSDE": { x: 0, y: 0 },
      "holder:PERINTIS": { x: 40, y: 0 },
    },
  }
  const printed = (unit: number) =>
    Effect.map(
      printedInside(graph, layout, { cx: 0, cy: 0, unit }, true),
      (nodes) => nodes.map(({ id, inside }) => [id, inside])
    )

  it.effect("prints a stock's code however far the map is zoomed out", () =>
    Effect.gen(function* () {
      expect(yield* printed(4)).toEqual([["stock:BSDE", "BSDE"]])
    })
  )

  it.effect("prints a holder's type once zoomed in to fit it", () =>
    Effect.gen(function* () {
      expect(yield* printed(0.25)).toEqual([
        ["stock:BSDE", "BSDE"],
        ["holder:PERINTIS", "CP"],
      ])
    })
  )
})

describe("mapDefinition", () => {
  // A hub focus's holders, every one in one style: the dots a hover, pan
  // or zoom defines again on the main thread.
  const HOLDERS = 60_000
  const nodes = Array.from({ length: HOLDERS }, (_, at): MapNode => ({
    ...holder(undefined),
    id: `holder:H${at}`,
  }))
  const graph = { key: "holder:HUB@2026-11-20", nodes, links: [] }
  const layout = {
    positions: Object.fromEntries(
      nodes.map(({ id }, at) => [id, { x: at % 300, y: Math.floor(at / 300) }])
    ),
  }

  it.effect("defines a hub's dots of one style in linear time", () =>
    Effect.gen(function* () {
      const start = performance.now()
      yield* mapDefinition({
        graph,
        layout,
        view: { cx: 150, cy: 100, unit: 1 },
        size: { width: 800, height: 600 },
        hovered: undefined,
        searched: undefined,
        showOffList: true,
        nodeOf: () => undefined,
      })
      // Grouping by copying a style's group for each dot took seconds.
      expect(performance.now() - start).toBeLessThan(1_000)
    })
  )
})
