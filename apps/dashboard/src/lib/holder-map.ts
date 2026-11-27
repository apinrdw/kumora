// The Holder map's view model (spec apinrdw/kumora#733, "View model"): the
// read turned into what the page shows, the focus's side panel, a section
// per band, and the graph's nodes, links and legend, or the landing view's
// stocks.
import type { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { KseiType } from "@/domain/holdings"
import type { HolderMapLink, HolderMapRead } from "@/server/holdings/holder-map"

export type Band = HolderMapLink["band"]

type Origin = HolderMapLink["origin"]

// One band's section of the side panel.
export interface BandSection {
  readonly band: Band
  // The band's report: the 5% band's trading day, the 1% band's above-1%
  // report; undefined when none is parsed.
  readonly date: WibDate | undefined
  // Most % first, then by name.
  readonly holders: ReadonlyArray<HolderMapLink>
  // Their summed % × 100.
  readonly totalHundredths: number
}

// The search a node's click navigates to. A holder gains one with holder
// focus (apinrdw/kumora#738), a custodian with custodian focus (#739).
export type Refocus = { readonly stock: StockCode }

// One dot of the graph.
export interface MapNode {
  // `stock:<code>` or `holder:<holder key>`: unique in the graph, stable
  // across reloads.
  readonly id: string
  readonly kind: "stock" | "holder"
  // A stock's code; a holder's name as published.
  readonly name: string
  // The name shortened for a label beside the dot.
  readonly label: string
  // What the dot prints inside: a stock's code, a holder's KSEI type.
  readonly inside: string | undefined
  // A holder's band, filled or outlined; undefined on a stock.
  readonly band: Band | undefined
  readonly origin: Origin
  readonly investorType: KseiType | undefined
  // A holder's % of the focus stock × 100; undefined on a stock.
  readonly stakeHundredths: number | undefined
  readonly shares: number | undefined
  // In layout units, following the stake.
  readonly radius: number
  readonly focus: boolean
  // Always labelled: the focus and its direct neighbours. Any other node is
  // labelled only while hovered or searched.
  readonly labelled: boolean
  readonly refocus: Refocus | undefined
}

// One line between two nodes, a holding.
export interface MapLink {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly band: Band
  readonly stakeHundredths: number
  // In layout units, following the stake.
  readonly width: number
}

export interface LegendEntry {
  readonly kind: "node" | "band" | "origin"
  readonly key: string
  readonly label: string
}

export interface HolderMapView {
  readonly day: WibDate | undefined
  readonly month: WibDate | undefined
  readonly focus:
    | {
        readonly code: StockCode
        readonly issuerName: string | undefined
        // The 5% band, then the 1% band.
        readonly bands: readonly [BandSection, BandSection]
        // The focus first, then the side panel's holders in its order.
        readonly graph: {
          readonly nodes: ReadonlyArray<MapNode>
          readonly links: ReadonlyArray<MapLink>
        }
        // In the legend's order, only what the graph draws.
        readonly legend: ReadonlyArray<LegendEntry>
      }
    | undefined
  readonly mostHeld: HolderMapRead["mostHeld"]
}

export const BAND_TITLE: Record<Band, string> = {
  "5%": "5% and above",
  "1%": "1% to 5%",
}

export const ORIGIN_LABEL: Record<NonNullable<Origin>, string> = {
  local: "Local",
  foreign: "Foreign",
  mixed: "Local and foreign",
}

// A label's longest name before it is cut.
const LABEL_LENGTH = 28

// The focus stock's radius, and a holder's at 0%, plus its growth with the
// square root of its %, so a dot's area follows the stake.
const FOCUS_RADIUS = 22
const HOLDER_RADIUS = 5
const RADIUS_PER_ROOT_PERCENT = 2
// A link's width at 0% and per %.
const LINK_WIDTH = 0.6
const WIDTH_PER_PERCENT = 0.12

const section = (
  band: Band,
  date: WibDate | undefined,
  links: ReadonlyArray<HolderMapLink>
) =>
  Effect.sync((): BandSection => {
    const holders = links
      .filter((link) => link.band === band)
      .sort(
        (a, b) =>
          b.percentageHundredths - a.percentageHundredths ||
          a.name.localeCompare(b.name)
      )
    return {
      band,
      date,
      holders,
      totalHundredths: holders.reduce(
        (sum, { percentageHundredths }) => sum + percentageHundredths,
        0
      ),
    }
  })

const labelOf = (name: string) =>
  Effect.succeed(
    name.length > LABEL_LENGTH ? `${name.slice(0, LABEL_LENGTH)}…` : name
  )

const holderNode = Effect.fnUntraced(function* (holder: HolderMapLink) {
  return {
    id: `holder:${holder.holder}`,
    kind: "holder",
    name: holder.name,
    label: yield* labelOf(holder.name),
    inside: holder.investorType,
    band: holder.band,
    origin: holder.origin,
    investorType: holder.investorType,
    stakeHundredths: holder.percentageHundredths,
    shares: holder.shares,
    radius:
      HOLDER_RADIUS +
      RADIUS_PER_ROOT_PERCENT * Math.sqrt(holder.percentageHundredths / 100),
    focus: false,
    labelled: true,
    refocus: undefined,
  } satisfies MapNode
})

const graphOf = Effect.fnUntraced(function* (
  code: StockCode,
  bands: readonly [BandSection, BandSection]
) {
  const holders = bands.flatMap((band) => band.holders)
  const focus: MapNode = {
    id: `stock:${code}`,
    kind: "stock",
    name: code,
    label: code,
    inside: code,
    band: undefined,
    origin: undefined,
    investorType: undefined,
    stakeHundredths: undefined,
    shares: undefined,
    radius: FOCUS_RADIUS,
    focus: true,
    labelled: true,
    refocus: { stock: code },
  }
  const nodes: Array<MapNode> = [focus]
  for (const holder of holders) nodes.push(yield* holderNode(holder))
  const links = holders.map((holder): MapLink => ({
    id: `${focus.id}->holder:${holder.holder}`,
    source: focus.id,
    target: `holder:${holder.holder}`,
    band: holder.band,
    stakeHundredths: holder.percentageHundredths,
    width: LINK_WIDTH + (WIDTH_PER_PERCENT * holder.percentageHundredths) / 100,
  }))
  return { nodes, links }
})

const ORIGIN_ORDER = ["local", "foreign", "mixed", undefined] as const

const legendOf = (nodes: ReadonlyArray<MapNode>) =>
  Effect.sync((): ReadonlyArray<LegendEntry> => {
    const holders = nodes.filter(({ kind }) => kind === "holder")
    const kinds: Array<LegendEntry> = [
      { kind: "node", key: "stock", label: "Stock" },
      ...(holders.length > 0
        ? [{ kind: "node" as const, key: "holder", label: "Holder" }]
        : []),
    ]
    const bands = (["5%", "1%"] as const)
      .filter((band) => holders.some((node) => node.band === band))
      .map((band): LegendEntry => ({
        kind: "band",
        key: band,
        label: BAND_TITLE[band],
      }))
    const origins = ORIGIN_ORDER.filter((origin) =>
      holders.some((node) => node.origin === origin)
    ).map((origin): LegendEntry => ({
      kind: "origin",
      key: origin ?? "unknown",
      label: origin === undefined ? "Origin unknown" : ORIGIN_LABEL[origin],
    }))
    return [...kinds, ...bands, ...origins]
  })

export const holderMapView = Effect.fnUntraced(function* (
  read: HolderMapRead
): Effect.fn.Return<HolderMapView> {
  const { day, month, focus, links, mostHeld } = read
  if (focus === undefined) return { day, month, focus: undefined, mostHeld }
  const bands = [
    yield* section("5%", day, links),
    yield* section("1%", month, links),
  ] as const
  const graph = yield* graphOf(focus.code, bands)
  return {
    day,
    month,
    focus: {
      code: focus.code,
      issuerName: focus.issuerName,
      bands,
      graph,
      legend: yield* legendOf(graph.nodes),
    },
    mostHeld,
  }
})
