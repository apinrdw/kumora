import { describe, expect, it } from "@effect/vitest"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { CustodianId, HolderKey } from "@/domain/holdings"
import { type HolderMapView, holderMapView } from "@/lib/holder-map"
import type {
  HolderMapCustodianLink,
  HolderMapLink,
  HolderMapOffList,
  HolderMapRead,
} from "@/server/holdings/holder-map-schema"

const link = (
  band: HolderMapLink["band"],
  name: string,
  hundredths: number
): HolderMapLink => ({
  code: StockCode.make("TRUE"),
  band,
  holder: HolderKey.make(name),
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
  hops: [],
  custodians: [],
  issuers: [],
  offList: [],
  offListCut: false,
  mostHeld: [],
})

// A holding's shares at a custodian: a broker's, by its code, else a bank's
// by its name's key.
const through = (
  holder: string,
  custodian: string,
  shares: number,
  code = "TRUE"
): HolderMapCustodianLink => {
  const broker = /^[A-Z]{2}$/.test(custodian)
    ? BrokerCode.make(custodian)
    : undefined
  return {
    code: StockCode.make(code),
    holder: HolderKey.make(holder),
    custodian: CustodianId.make(custodian),
    broker,
    name: broker === undefined ? custodian : `BROKER ${custodian}`,
    shares,
  }
}

const off = (
  band: HolderMapLink["band"],
  name: string,
  since: string
): HolderMapOffList => ({
  code: StockCode.make("TRUE"),
  band,
  holder: HolderKey.make(name),
  name,
  since: WibDate.make(since),
  percentageHundredths: 300,
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

  it.effect("colours each holder's link by the move its row shows", () =>
    Effect.gen(function* () {
      const view = yield* holderMapView(
        read([
          {
            ...link("5%", "A", 900),
            move: { kind: "up", shareChange: 1000, percentageChange: 20 },
            crossing: { kind: "up into 5%", monthHundredths: 450 },
          },
          {
            ...link("5%", "B", 800),
            move: { kind: "transfer", shareChange: 0, percentageChange: 0 },
          },
          link("1%", "C", 200),
        ])
      )
      expect(
        view.focus?.graph.links.map(({ target, move }) => [target, move])
      ).toEqual([
        ["holder:A", "up into 5%"],
        ["holder:B", "transfer"],
        ["holder:C", "unchanged"],
      ])
    })
  )

  it.effect(
    "gives a crossing node no stored change, as it is the day's or the month's, not the crossing's",
    () =>
      Effect.gen(function* () {
        // At 4.50% at month-end and 6.95% now, down 0.77% today: the
        // tooltip says Up into 5%, never Up into 5% −0.77%.
        const view = yield* holderMapView(
          read([
            {
              ...link("5%", "A", 695),
              move: { kind: "down", shareChange: -1000, percentageChange: -77 },
              crossing: { kind: "up into 5%", monthHundredths: 450 },
            },
            {
              ...link("1%", "B", 600),
              move: { kind: "up", shareChange: 1000, percentageChange: 12 },
              crossing: {
                kind: "down out of 5%",
                since: WibDate.make("2026-11-20"),
              },
            },
            {
              ...link("5%", "C", 900),
              move: { kind: "down", shareChange: -1000, percentageChange: -77 },
            },
          ])
        )
        expect(
          view.focus?.graph.nodes
            .filter(({ kind }) => kind === "holder")
            .map(({ name, move }) => [name, move])
        ).toEqual([
          ["C", { kind: "down", percentageChange: -77 }],
          ["A", { kind: "up into 5%", percentageChange: undefined }],
          ["B", { kind: "down out of 5%", percentageChange: undefined }],
        ])
      })
  )

  it.effect(
    "draws each Off list holder after the holders, linked as Off list, and names it in the legend",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView({
          ...read([link("5%", "A", 900)]),
          offList: [off("1%", "B", "2026-08-31"), off("5%", "C", "2026-11-19")],
        })
        const graph = view.focus?.graph
        expect(
          graph?.nodes.map(({ name, offList, move }) => [name, offList, move])
        ).toEqual([
          ["TRUE", false, undefined],
          ["A", false, { kind: "unchanged", percentageChange: undefined }],
          [
            "C",
            true,
            { kind: "off list", band: "5%", since: WibDate.make("2026-11-19") },
          ],
          [
            "B",
            true,
            { kind: "off list", band: "1%", since: WibDate.make("2026-08-31") },
          ],
        ])
        expect(graph?.links.map(({ target, move }) => [target, move])).toEqual([
          ["holder:A", "unchanged"],
          ["holder:C", "off list"],
          ["holder:B", "off list"],
        ])
        // An Off list holder's band and unknown origin aren't drawn.
        expect(view.focus?.legend.map(({ label }) => label)).toEqual([
          "Stock",
          "Holder",
          "5% and above",
          "Local",
          "Unchanged",
          "Off list",
        ])
      })
  )

  it.effect("keys the map on its focus and day", () =>
    Effect.gen(function* () {
      const on = (day: string, code = "TRUE") =>
        holderMapView({
          ...read([link("5%", "A", 900)]),
          day: WibDate.make(day),
          focus: {
            kind: "stock",
            code: StockCode.make(code),
            issuerName: code,
          },
        })
      const key = (view: HolderMapView) => view.focus?.graph.key
      expect(key(yield* on("2026-11-20"))).toBe("stock:TRUE@2026-11-20")
      expect(key(yield* on("2026-11-19"))).toBe("stock:TRUE@2026-11-19")
      expect(key(yield* on("2026-11-20", "FLMC"))).toBe("stock:FLMC@2026-11-20")
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
    "marks the focus, labels it and its holders, and refocuses a click on a holder",
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
          refocus: { holder: "A" },
        })
      })
  )

  it.effect(
    "lists the hop beyond for the side panel, by first-hop row, then most %",
    () =>
      Effect.gen(function* () {
        const at = (code: string, held: HolderMapLink) => ({
          ...held,
          code: StockCode.make(code),
        })
        const stock = yield* holderMapView({
          ...read([link("5%", "A", 900), link("1%", "B", 200)]),
          hops: [
            at("BSDE", link("1%", "B", 150)),
            at("BSDE", link("1%", "A", 300)),
            at("TLKM", link("5%", "A", 600)),
          ],
          issuers: [{ code: StockCode.make("TLKM"), issuerName: "TELKOM" }],
        })
        // Each of its holders' other stocks: A's, then B's, as the bands
        // list them.
        expect(
          stock.focus?.beyond.map(({ name, code, issuerName, shownMove }) => [
            name,
            code,
            issuerName,
            shownMove,
          ])
        ).toEqual([
          ["A", "TLKM", "TELKOM", "unchanged"],
          ["A", "BSDE", undefined, "unchanged"],
          ["B", "BSDE", undefined, "unchanged"],
        ])
        const holder = yield* holderMapView({
          ...read([]),
          focus: { kind: "holder", key: HolderKey.make("A"), name: "A" },
          links: [at("TLKM", link("1%", "A", 240)), link("5%", "A", 900)],
          hops: [
            at("TLKM", link("1%", "C", 150)),
            at("TRUE", link("5%", "B", 600)),
          ],
        })
        // Each of its stocks' other holders: TRUE's, then TLKM's.
        expect(
          holder.focus?.beyond.map(({ name, code }) => [code, name])
        ).toEqual([
          ["TRUE", "B"],
          ["TLKM", "C"],
        ])
      })
  )

  it.effect(
    "rings each holder's other stocks round it, unlabelled, their code inside",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView({
          ...read([link("5%", "A", 900), link("1%", "B", 200)]),
          hops: [
            { ...link("1%", "A", 300), code: StockCode.make("TLKM") },
            {
              ...link("5%", "B", 700),
              code: StockCode.make("BSDE"),
              move: { kind: "up", shareChange: 10, percentageChange: 5 },
            },
            { ...link("1%", "B", 120), code: StockCode.make("TLKM") },
          ],
          issuers: [
            { code: StockCode.make("BSDE"), issuerName: "BUMI SERPONG" },
            { code: StockCode.make("TLKM"), issuerName: "TELKOM" },
          ],
        })
        const graph = view.focus?.graph
        // One node a stock, however many of the focus's holders hold it.
        expect(
          graph?.nodes
            .slice(3)
            .map(({ id, labelled, inside, refocus, issuerName }) => [
              id,
              labelled,
              inside,
              refocus,
              issuerName,
            ])
        ).toEqual([
          ["stock:BSDE", false, "BSDE", { stock: "BSDE" }, "BUMI SERPONG"],
          ["stock:TLKM", false, "TLKM", { stock: "TLKM" }, "TELKOM"],
        ])
        expect(
          graph?.links
            .slice(2)
            .map(({ source, target, band, move }) => [
              source,
              target,
              band,
              move,
            ])
          // By stock, then holder: a stable order for the layout.
        ).toEqual([
          ["holder:B", "stock:BSDE", "5%", "up"],
          ["holder:A", "stock:TLKM", "1%", "unchanged"],
          ["holder:B", "stock:TLKM", "1%", "unchanged"],
        ])
        expect(graph?.links.map(({ id }) => id)).toEqual([
          ...new Set(graph?.links.map(({ id }) => id)),
        ])
      })
  )

  it.effect(
    "draws a holder focus linked to its stocks, and their other holders once each",
    () =>
      Effect.gen(function* () {
        const at = (code: string, held: HolderMapLink) => ({
          ...held,
          code: StockCode.make(code),
        })
        const view = yield* holderMapView({
          ...read([]),
          focus: { kind: "holder", key: HolderKey.make("A"), name: "PT A" },
          links: [
            at("TLKM", { ...link("1%", "A", 240), name: "PT A" }),
            at("BSDE", { ...link("5%", "A", 900), name: "PT A" }),
          ],
          hops: [
            at("BSDE", link("1%", "B", 300)),
            at("TLKM", link("5%", "B", 600)),
            at("TLKM", link("1%", "C", 150)),
          ],
          issuers: [
            { code: StockCode.make("BSDE"), issuerName: "BUMI SERPONG" },
            { code: StockCode.make("TLKM"), issuerName: "TELKOM" },
          ],
          offList: [
            { ...off("1%", "A", "2026-08-31"), code: StockCode.make("TRUE") },
          ],
        })
        const held = view.focus
        expect(held?.kind).toBe("holder")
        expect(held?.title).toBe("PT A")
        // Its stocks, by band, most % first.
        expect(
          held?.bands.map(({ band, holders }) => [
            band,
            holders.map(({ code }) => code),
          ])
        ).toEqual([
          ["5%", ["BSDE"]],
          ["1%", ["TLKM"]],
        ])
        expect(
          held?.graph.nodes.map(({ id, focus, labelled, offList, refocus }) => [
            id,
            focus,
            labelled,
            offList,
            refocus,
          ])
        ).toEqual([
          ["holder:A", true, true, false, { holder: "A" }],
          ["stock:BSDE", false, true, false, { stock: "BSDE" }],
          ["stock:TLKM", false, true, false, { stock: "TLKM" }],
          ["stock:TRUE", false, false, true, { stock: "TRUE" }],
          ["holder:B", false, false, false, { holder: "B" }],
          ["holder:C", false, false, false, { holder: "C" }],
        ])
        // B holds two of its stocks: its node takes its largest holding.
        const b = held?.graph.nodes.find(({ id }) => id === "holder:B")
        expect([b?.band, b?.stakeHundredths, b?.holding]).toEqual([
          "5%",
          600,
          { code: "TLKM", holderName: "B" },
        ])
        expect(
          held?.graph.links.map(({ source, target, move }) => [
            source,
            target,
            move,
          ])
        ).toEqual([
          ["holder:A", "stock:BSDE", "unchanged"],
          ["holder:A", "stock:TLKM", "unchanged"],
          ["holder:A", "stock:TRUE", "off list"],
          ["stock:BSDE", "holder:B", "unchanged"],
          ["stock:TLKM", "holder:B", "unchanged"],
          ["stock:TLKM", "holder:C", "unchanged"],
        ])
        expect(held?.graph.key).toBe("holder:A@2026-11-20")
      })
  )

  it.effect(
    "links each above-5% holder to its custodians, one node a custodian, sized by shares",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView({
          ...read([link("5%", "A", 900), link("5%", "B", 600)]),
          // A's 900,000 shares, two thirds at YP; B's all at YP.
          custodians: [
            through("A", "CITIBANK", 300_000),
            through("A", "YP", 600_000),
            through("B", "YP", 600_000),
          ],
        })
        const graph = view.focus?.graph
        expect(
          graph?.nodes
            .filter(({ kind }) => kind === "custodian")
            .map(({ id, name, inside, labelled, refocus, shares }) => [
              id,
              name,
              inside,
              labelled,
              refocus,
              shares,
            ])
        ).toEqual([
          [
            "custodian:CITIBANK",
            "CITIBANK",
            undefined,
            false,
            { custodian: "CITIBANK" },
            300_000,
          ],
          [
            "custodian:YP",
            "BROKER YP",
            "YP",
            false,
            { custodian: "YP" },
            1_200_000,
          ],
        ])
        const custodianLinks = (graph?.links ?? []).filter(({ source }) =>
          source.startsWith("custodian:")
        )
        expect(
          custodianLinks.map(({ source, target, move, stakeHundredths }) => [
            source,
            target,
            move,
            stakeHundredths,
          ])
        ).toEqual([
          ["custodian:CITIBANK", "holder:A", undefined, 300],
          ["custodian:YP", "holder:A", undefined, 600],
          ["custodian:YP", "holder:B", undefined, 600],
        ])
        expect(view.focus?.legend.map(({ label }) => label)).toEqual([
          "Stock",
          "Holder",
          "Custodian",
          "5% and above",
          "Local",
          "Unchanged",
        ])
        // The side panel lists them, most shares first.
        expect(
          view.focus?.custodians.map(({ id, shares, holders }) => [
            id,
            shares,
            holders,
          ])
        ).toEqual([
          ["YP", 1_200_000, 2],
          ["CITIBANK", 300_000, 1],
        ])
      })
  )

  it.effect(
    "draws a custodian focus linked to its holders, once each, and their stocks through it",
    () =>
      Effect.gen(function* () {
        const at = (code: string, held: HolderMapLink) => ({
          ...held,
          code: StockCode.make(code),
        })
        const view = yield* holderMapView({
          ...read([]),
          focus: {
            kind: "custodian",
            id: CustodianId.make("ZP"),
            broker: BrokerCode.make("ZP"),
            name: "MAYBANK SEKURITAS INDONESIA",
          },
          links: [
            at("ASRI", link("5%", "M", 900)),
            at("ENRG", {
              ...link("5%", "M", 1000),
              move: { kind: "up", shareChange: 10, percentageChange: 5 },
            }),
            at("ASRI", link("5%", "T", 2000)),
          ],
          custodians: [
            through("M", "ZP", 900_000, "ASRI"),
            through("M", "ZP", 400_000, "ENRG"),
            through("M", "PD", 600_000, "ENRG"),
            through("T", "ZP", 1_000, "ASRI"),
            through("T", "PD", 1_999_000, "ASRI"),
          ],
          issuers: [
            { code: StockCode.make("ASRI"), issuerName: "ALAM SUTERA" },
            { code: StockCode.make("ENRG"), issuerName: "ENERGI MEGA" },
          ],
        })
        const custodian = view.focus
        expect(custodian?.kind).toBe("custodian")
        expect(custodian?.title).toBe("MAYBANK SEKURITAS INDONESIA")
        expect(custodian?.bands).toEqual([])
        // Its book: each holder and stock with the shares held through it.
        const book =
          custodian?.kind === "custodian" ? custodian.book : undefined
        expect(
          book?.holders.map(({ key, name, shares, stocks }) => [
            key,
            name,
            shares,
            stocks,
          ])
        ).toEqual([
          ["M", "M", 1_300_000, ["ASRI", "ENRG"]],
          ["T", "T", 1_000, ["ASRI"]],
        ])
        expect(
          book?.stocks.map(({ code, issuerName, shares, holders }) => [
            code,
            issuerName,
            shares,
            holders,
          ])
        ).toEqual([
          ["ASRI", "ALAM SUTERA", 901_000, 2],
          ["ENRG", "ENERGI MEGA", 400_000, 1],
        ])
        // Its other custodians, not itself.
        expect(custodian?.custodians.map(({ id }) => id)).toEqual(["PD"])
        expect(
          custodian?.graph.nodes.map(({ id, focus, labelled, refocus }) => [
            id,
            focus,
            labelled,
            refocus,
          ])
        ).toEqual([
          ["custodian:ZP", true, true, { custodian: "ZP" }],
          ["holder:M", false, true, { holder: "M" }],
          ["holder:T", false, true, { holder: "T" }],
          ["stock:ASRI", false, false, { stock: "ASRI" }],
          ["stock:ENRG", false, false, { stock: "ENRG" }],
          ["custodian:PD", false, false, { custodian: "PD" }],
        ])
        expect(
          custodian?.graph.links.map(({ source, target, move }) => [
            source,
            target,
            move,
          ])
        ).toEqual([
          ["holder:M", "stock:ASRI", "unchanged"],
          ["holder:T", "stock:ASRI", "unchanged"],
          ["holder:M", "stock:ENRG", "up"],
          ["custodian:PD", "holder:M", undefined],
          ["custodian:PD", "holder:T", undefined],
          ["custodian:ZP", "holder:M", undefined],
          ["custodian:ZP", "holder:T", undefined],
        ])
        expect(custodian?.graph.key).toBe("custodian:ZP@2026-11-20")
      })
  )

  it.effect(
    "draws a custodian's Off list holders once each, not those still holding through it",
    () =>
      Effect.gen(function* () {
        const view = yield* holderMapView({
          ...read([]),
          focus: {
            kind: "custodian",
            id: CustodianId.make("ZP"),
            broker: BrokerCode.make("ZP"),
            name: "MAYBANK SEKURITAS INDONESIA",
          },
          links: [link("5%", "M", 900)],
          custodians: [through("M", "ZP", 900_000)],
          offList: [
            // M left TLKM through it, but still holds TRUE through it.
            { ...off("5%", "M", "2026-11-19"), code: StockCode.make("TLKM") },
            { ...off("5%", "D", "2026-11-19"), code: StockCode.make("TLKM") },
            { ...off("5%", "D", "2026-11-18"), code: StockCode.make("BSDE") },
          ],
        })
        const graph = view.focus?.graph
        expect(view.focus?.offList).toHaveLength(3)
        expect(graph?.nodes.map(({ id, offList }) => [id, offList])).toEqual([
          ["custodian:ZP", false],
          ["holder:M", false],
          ["holder:D", true],
          ["stock:TRUE", false],
        ])
        expect(
          graph?.links
            .filter(({ move }) => move === "off list")
            .map(({ source, target }) => [source, target])
        ).toEqual([["custodian:ZP", "holder:D"]])
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
    "names in the legend each node kind, band, origin and move the map draws",
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
          "Unchanged",
        ])
        const only5 = yield* holderMapView(read([link("5%", "A", 900)]))
        expect(only5.focus?.legend.map(({ label }) => label)).toEqual([
          "Stock",
          "Holder",
          "5% and above",
          "Local",
          "Unchanged",
        ])
      })
  )

  it.effect("names each move the links show, in Holder moves' order", () =>
    Effect.gen(function* () {
      const moved = (kind: "new" | "up" | "down" | "transfer") => ({
        kind,
        shareChange: 1000,
        percentageChange: 10,
      })
      const view = yield* holderMapView(
        read([
          { ...link("5%", "A", 900), move: moved("transfer") },
          {
            ...link("5%", "B", 800),
            crossing: {
              kind: "down out of 5%",
              since: WibDate.make("2026-11-20"),
            },
          },
          { ...link("5%", "C", 700), move: moved("new") },
          { ...link("1%", "D", 300), move: moved("down") },
          {
            ...link("5%", "E", 600),
            crossing: { kind: "up into 5%", monthHundredths: 450 },
          },
        ])
      )
      expect(
        view.focus?.legend
          .filter(({ kind }) => kind === "move")
          .map(({ key, label }) => [key, label])
      ).toEqual([
        ["new", "New"],
        ["down", "Down"],
        ["transfer", "Transfer"],
        ["up into 5%", "Up into 5%"],
        ["down out of 5%", "Down out of 5%"],
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
