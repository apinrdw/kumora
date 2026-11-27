// The Holder map's view model (spec apinrdw/kumora#733, "View model"): the
// read turned into what the page shows, the focus's side panel, a section
// per band, its custodians and a custodian focus's book, and the graph
// (lib/holder-map-graph.ts), or the landing view's stocks.
import type { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { CustodianId, HolderKey } from "@/domain/holdings"
import type {
  HolderMapCustodianLink,
  HolderMapLink,
  HolderMapOffList,
  HolderMapRead,
} from "@/server/holdings/holder-map-schema"

import {
  type Band,
  type GraphFocus,
  graphOf,
  type LegendEntry,
  legendOf,
  type MapCustodian,
  type MapGraph,
  type ShownMove,
  shownMoveOf,
} from "./holder-map-graph"

// A holding as the side panel lists it: a stock focus's holder, or a
// holder focus's stock.
export interface MapHolder extends HolderMapLink {
  readonly shownMove: ShownMove
  // Its stock's, as the report prints it.
  readonly issuerName: string | undefined
}

// One band's section of the side panel.
export interface BandSection {
  readonly band: Band
  // The band's report: the 5% band's trading day, the 1% band's above-1%
  // report; undefined when none is parsed.
  readonly date: WibDate | undefined
  // Most % first, then by name and stock.
  readonly holders: ReadonlyArray<MapHolder>
  // Their summed % × 100.
  readonly totalHundredths: number
}

// A custodian focus's book: what it holds, for whom.
export interface CustodianBook {
  // Most shares first, then by name.
  readonly holders: ReadonlyArray<{
    readonly key: HolderKey
    readonly name: string
    // Held through it, in every stock.
    readonly shares: number
    // By code.
    readonly stocks: ReadonlyArray<StockCode>
  }>
  // Most shares first, then by code.
  readonly stocks: ReadonlyArray<{
    readonly code: StockCode
    readonly issuerName: string | undefined
    // Held through it, by every holder.
    readonly shares: number
    readonly holders: number
  }>
}

// What the map is drawn around.
export type FocusView = (
  | {
      readonly kind: "stock"
      readonly code: StockCode
      readonly issuerName: string | undefined
    }
  | {
      readonly kind: "holder"
      readonly key: HolderKey
      readonly name: string | undefined
    }
  | {
      readonly kind: "custodian"
      readonly id: CustodianId
      readonly broker: BrokerCode | undefined
      readonly name: string | undefined
      readonly book: CustodianBook
    }
) & {
  // What the map is of: a stock's code, a holder's or custodian's name,
  // else its key or id.
  readonly title: string
  // The 5% band, then the 1% band; the 5% band only for a day before any
  // above-1% month, none for a refused day or a custodian focus.
  readonly bands: ReadonlyArray<BandSection>
  // The hop beyond, so the side panel lists every node the graph draws: a
  // stock focus's holders' other stocks, by the bands' order of their
  // holders, or a holder focus's stocks' other holders, by its stocks';
  // each most % first. None for a custodian focus, whose book lists its
  // holders and stocks.
  readonly beyond: ReadonlyArray<MapHolder>
  // The custodians the graph draws, but the focus; most shares first.
  readonly custodians: ReadonlyArray<MapCustodian>
  readonly graph: MapGraph
  // In the legend's order, only what the graph draws.
  readonly legend: ReadonlyArray<LegendEntry>
  // Its earlier holdings, latest to leave first, then by name and stock.
  readonly offList: ReadonlyArray<HolderMapOffList>
}

export interface HolderMapView {
  readonly day: WibDate | undefined
  readonly month: WibDate | undefined
  readonly refused: WibDate | undefined
  readonly days: ReadonlyArray<WibDate>
  readonly focus: FocusView | undefined
  readonly mostHeld: HolderMapRead["mostHeld"]
}

// A holding with what the side panel shows of it.
const shownOf = Effect.fnUntraced(function* (
  link: HolderMapLink,
  issuers: ReadonlyMap<StockCode, string>
) {
  return {
    ...link,
    shownMove: yield* shownMoveOf(link),
    issuerName: issuers.get(link.code),
  } satisfies MapHolder as MapHolder
})

const section = Effect.fnUntraced(function* (
  band: Band,
  date: WibDate | undefined,
  links: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) {
  const holders: Array<MapHolder> = []
  for (const link of links)
    if (link.band === band) holders.push(yield* shownOf(link, issuers))
  holders.sort(
    (a, b) =>
      b.percentageHundredths - a.percentageHundredths ||
      a.name.localeCompare(b.name) ||
      a.code.localeCompare(b.code)
  )
  return {
    band,
    date,
    holders,
    totalHundredths: holders.reduce(
      (sum, { percentageHundredths }) => sum + percentageHundredths,
      0
    ),
  } satisfies BandSection as BandSection
})

// The hop beyond in the side panel's order: grouped by the first-hop row
// it hangs off, a holder of a stock focus or a stock of a holder focus.
const beyondOf = Effect.fnUntraced(function* (
  kind: "stock" | "holder",
  bands: ReadonlyArray<BandSection>,
  hops: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) {
  const near = (link: HolderMapLink): string =>
    kind === "stock" ? link.holder : link.code
  const row = new Map<string, number>()
  for (const { holders } of bands)
    for (const holder of holders)
      if (!row.has(near(holder))) row.set(near(holder), row.size)
  const beyond: Array<MapHolder> = []
  for (const hop of hops) beyond.push(yield* shownOf(hop, issuers))
  return beyond.sort(
    (a, b) =>
      (row.get(near(a)) ?? row.size) - (row.get(near(b)) ?? row.size) ||
      b.percentageHundredths - a.percentageHundredths ||
      a.name.localeCompare(b.name) ||
      a.code.localeCompare(b.code)
  )
})

// The custodians of `links`, each once, by id.
const custodiansOf = (links: ReadonlyArray<HolderMapCustodianLink>) =>
  Effect.sync((): ReadonlyArray<MapCustodian> => {
    const byId = new Map<
      CustodianId,
      { custodian: MapCustodian; holders: Set<HolderKey> }
    >()
    for (const link of links) {
      const known = byId.get(link.custodian)
      const holders = known?.holders ?? new Set<HolderKey>()
      holders.add(link.holder)
      byId.set(link.custodian, {
        custodian: {
          id: link.custodian,
          broker: link.broker,
          name: link.name,
          shares: (known?.custodian.shares ?? 0) + link.shares,
          holders: holders.size,
        },
        holders,
      })
    }
    return [...byId.values()]
      .map(({ custodian }) => custodian)
      .sort((a, b) => b.shares - a.shares || a.name.localeCompare(b.name))
  })

// A custodian focus's book, from its own links.
const bookOf = (
  id: CustodianId,
  custodians: ReadonlyArray<HolderMapCustodianLink>,
  holdings: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) =>
  Effect.sync((): CustodianBook => {
    const names = new Map(
      holdings.map((holding) => [holding.holder, holding.name])
    )
    const holders = new Map<
      HolderKey,
      { shares: number; stocks: Set<StockCode> }
    >()
    const stocks = new Map<
      StockCode,
      { shares: number; holders: Set<HolderKey> }
    >()
    for (const link of custodians) {
      if (link.custodian !== id) continue
      const holder = holders.get(link.holder) ?? {
        shares: 0,
        stocks: new Set<StockCode>(),
      }
      holder.shares += link.shares
      holder.stocks.add(link.code)
      holders.set(link.holder, holder)
      const stock = stocks.get(link.code) ?? {
        shares: 0,
        holders: new Set<HolderKey>(),
      }
      stock.shares += link.shares
      stock.holders.add(link.holder)
      stocks.set(link.code, stock)
    }
    return {
      holders: [...holders]
        .map(([key, { shares, stocks: of }]) => ({
          key,
          name: names.get(key) ?? key,
          shares,
          stocks: [...of].sort(),
        }))
        .sort((a, b) => b.shares - a.shares || a.name.localeCompare(b.name)),
      stocks: [...stocks]
        .map(([code, { shares, holders: of }]) => ({
          code,
          issuerName: issuers.get(code),
          shares,
          holders: of.size,
        }))
        .sort((a, b) => b.shares - a.shares || a.code.localeCompare(b.code)),
    }
  })

// The focus as the page names it.
const focusOf = Effect.fnUntraced(function* (
  read: HolderMapRead,
  focus: NonNullable<HolderMapRead["focus"]>,
  issuers: ReadonlyMap<StockCode, string>
) {
  if (focus.kind === "stock")
    return {
      kind: "stock" as const,
      code: focus.code,
      issuerName: focus.issuerName,
      title: focus.code as string,
    }
  if (focus.kind === "holder")
    return {
      kind: "holder" as const,
      key: focus.key,
      name: focus.name,
      title: focus.name ?? focus.key,
    }
  return {
    kind: "custodian" as const,
    id: focus.id,
    broker: focus.broker,
    name: focus.name,
    title: focus.name ?? focus.id,
    book: yield* bookOf(focus.id, read.custodians, read.links, issuers),
  }
})

// The focus as the graph draws it.
const graphFocusOf = (named: Effect.Success<ReturnType<typeof focusOf>>) =>
  Effect.succeed<GraphFocus>(
    named.kind === "stock"
      ? named
      : named.kind === "holder"
        ? { kind: "holder", key: named.key, title: named.title }
        : {
            kind: "custodian",
            id: named.id,
            broker: named.broker,
            title: named.title,
            holders: named.book.holders,
          }
  )

export const holderMapView = Effect.fnUntraced(function* (
  read: HolderMapRead
): Effect.fn.Return<HolderMapView> {
  const { day, month, refused, days, focus, links, offList } = read
  if (focus === undefined)
    return {
      day,
      month,
      refused,
      days,
      focus: undefined,
      mostHeld: read.mostHeld,
    }
  const issuers = new Map(
    read.issuers.map(({ code, issuerName }) => [code, issuerName])
  )
  const bands: Array<BandSection> = []
  if (focus.kind !== "custodian") {
    if (day !== undefined) bands.push(yield* section("5%", day, links, issuers))
    if (month !== undefined)
      bands.push(yield* section("1%", month, links, issuers))
  }
  const earlier = [...offList].sort(
    (a, b) =>
      b.since.localeCompare(a.since) ||
      a.name.localeCompare(b.name) ||
      a.code.localeCompare(b.code)
  )
  const named = yield* focusOf(read, focus, issuers)
  const custodians = (yield* custodiansOf(read.custodians)).filter(
    ({ id }) => focus.kind !== "custodian" || id !== focus.id
  )
  const graph = yield* graphOf({
    focus: yield* graphFocusOf(named),
    asOf: day ?? month,
    holdings:
      focus.kind === "custodian"
        ? links
        : bands.flatMap(({ holders }) => holders),
    offList: earlier,
    hops: read.hops,
    custodians,
    custodianLinks: read.custodians,
    issuers,
  })
  return {
    day,
    month,
    refused,
    days,
    focus: {
      ...named,
      bands,
      beyond:
        focus.kind === "custodian"
          ? []
          : yield* beyondOf(focus.kind, bands, read.hops, issuers),
      custodians,
      graph,
      legend: yield* legendOf(graph),
      offList: earlier,
    },
    mostHeld: read.mostHeld,
  }
})
