// The Holder map's view model (spec apinrdw/kumora#733, "View model"): the
// read turned into what the page shows, the focus's side panel, a section
// per band, and the graph's nodes, links and legend, or the landing view's
// stocks.
import type { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { KseiType } from "@/domain/holdings"
import type {
  HolderMapLink,
  HolderMapOffList,
  HolderMapRead,
} from "@/server/holdings/holder-map"

export type Band = HolderMapLink["band"]

type Origin = HolderMapLink["origin"]

// What a holder's link shows, and the graph colours it by: its crossing of
// 5% between the bands' periods, else its stored move, else Unchanged.
export type ShownMove =
  | NonNullable<HolderMapLink["move"]>["kind"]
  | NonNullable<HolderMapLink["crossing"]>["kind"]
  | "unchanged"

export interface MapHolder extends HolderMapLink {
  readonly shownMove: ShownMove
}

// What a link shows: its holder's move, or Off list for a holder that left.
export type LinkMove = ShownMove | "off list"

// A holder node's move, as its tooltip names it.
export type NodeMove =
  | {
      readonly kind: ShownMove
      // Its % of the focus's change × 100; undefined when none is stored.
      readonly percentageChange: number | undefined
    }
  | {
      readonly kind: "off list"
      // The report it left, and the period it left.
      readonly band: Band
      readonly since: WibDate
    }

// One band's section of the side panel.
export interface BandSection {
  readonly band: Band
  // The band's report: the 5% band's trading day, the 1% band's above-1%
  // report; undefined when none is parsed.
  readonly date: WibDate | undefined
  // Most % first, then by name.
  readonly holders: ReadonlyArray<MapHolder>
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
  // A holder that left the focus's list: drawn faded and dashed, hidden by
  // the Off list toggle.
  readonly offList: boolean
  // A holder's; undefined on a stock.
  readonly move: NodeMove | undefined
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
  // What its holder's row shows, the link's colour.
  readonly move: LinkMove
}

export type LegendEntry =
  | {
      readonly kind: "node" | "band" | "origin"
      readonly key: string
      readonly label: string
    }
  | { readonly kind: "move"; readonly key: LinkMove; readonly label: string }

export interface HolderMapView {
  readonly day: WibDate | undefined
  readonly month: WibDate | undefined
  readonly refused: WibDate | undefined
  readonly days: ReadonlyArray<WibDate>
  readonly focus:
    | {
        readonly code: StockCode
        readonly issuerName: string | undefined
        // The 5% band, then the 1% band; the 5% band only for a day before
        // any above-1% month, none for a refused day.
        readonly bands: ReadonlyArray<BandSection>
        // The focus first, then the side panel's holders in its order.
        readonly graph: {
          // The focus and the day it is drawn as of: the layout's key, so a
          // reload of one focus and day lays out the same picture.
          readonly key: string
          readonly nodes: ReadonlyArray<MapNode>
          readonly links: ReadonlyArray<MapLink>
        }
        // In the legend's order, only what the graph draws.
        readonly legend: ReadonlyArray<LegendEntry>
        // Its earlier holders, latest to leave first, then by name.
        readonly offList: ReadonlyArray<HolderMapOffList>
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
      .map((link): MapHolder => ({
        ...link,
        shownMove: link.crossing?.kind ?? link.move?.kind ?? "unchanged",
      }))
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

// A node's radius and a link's width, following the %.
const radiusOf = (hundredths: number) =>
  HOLDER_RADIUS + RADIUS_PER_ROOT_PERCENT * Math.sqrt(hundredths / 100)
const widthOf = (hundredths: number) =>
  LINK_WIDTH + (WIDTH_PER_PERCENT * hundredths) / 100

const holderNode = Effect.fnUntraced(function* (holder: MapHolder) {
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
    radius: radiusOf(holder.percentageHundredths),
    focus: false,
    offList: false,
    move: {
      kind: holder.shownMove,
      percentageChange: holder.move?.percentageChange,
    },
    labelled: true,
    refocus: undefined,
  } satisfies MapNode
})

// An Off list holder, labelled only while hovered: it no longer holds.
const offListNode = Effect.fnUntraced(function* (holder: HolderMapOffList) {
  return {
    id: `holder:${holder.holder}`,
    kind: "holder",
    name: holder.name,
    label: yield* labelOf(holder.name),
    inside: undefined,
    band: holder.band,
    origin: undefined,
    investorType: undefined,
    stakeHundredths: holder.percentageHundredths,
    shares: undefined,
    radius: radiusOf(holder.percentageHundredths),
    focus: false,
    offList: true,
    move: { kind: "off list", band: holder.band, since: holder.since },
    labelled: false,
    refocus: undefined,
  } satisfies MapNode
})

const graphOf = Effect.fnUntraced(function* (
  code: StockCode,
  asOf: WibDate | undefined,
  bands: ReadonlyArray<BandSection>,
  offList: ReadonlyArray<HolderMapOffList>
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
    offList: false,
    move: undefined,
    labelled: true,
    refocus: { stock: code },
  }
  const nodes: Array<MapNode> = [focus]
  for (const holder of holders) nodes.push(yield* holderNode(holder))
  for (const holder of offList) nodes.push(yield* offListNode(holder))
  const linkTo = (
    holder: { readonly holder: string; readonly band: Band },
    hundredths: number,
    move: LinkMove
  ): MapLink => ({
    id: `${focus.id}->holder:${holder.holder}`,
    source: focus.id,
    target: `holder:${holder.holder}`,
    band: holder.band,
    stakeHundredths: hundredths,
    width: widthOf(hundredths),
    move,
  })
  const links = [
    ...holders.map((holder) =>
      linkTo(holder, holder.percentageHundredths, holder.shownMove)
    ),
    // Off list: no longer a holding, so its link is drawn at 0%.
    ...offList.map((holder) => linkTo(holder, 0, "off list")),
  ]
  return { key: `${focus.id}@${asOf ?? ""}`, nodes, links }
})

const ORIGIN_ORDER = ["local", "foreign", "mixed", undefined] as const

// Holder moves' order, then the crossings of 5%, then Off list.
export const MOVE_LABEL: Record<LinkMove, string> = {
  new: "New",
  up: "Up",
  down: "Down",
  transfer: "Transfer",
  unchanged: "Unchanged",
  "up into 5%": "Up into 5%",
  "down out of 5%": "Down out of 5%",
  "off list": "Off list",
}

const legendOf = (
  nodes: ReadonlyArray<MapNode>,
  links: ReadonlyArray<MapLink>
) =>
  Effect.sync((): ReadonlyArray<LegendEntry> => {
    const holders = nodes.filter(
      ({ kind, offList }) => kind === "holder" && !offList
    )
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
    const moves = (Object.keys(MOVE_LABEL) as Array<LinkMove>)
      .filter((move) => links.some((each) => each.move === move))
      .map((move): LegendEntry => ({
        kind: "move",
        key: move,
        label: MOVE_LABEL[move],
      }))
    return [...kinds, ...bands, ...origins, ...moves]
  })

export const holderMapView = Effect.fnUntraced(function* (
  read: HolderMapRead
): Effect.fn.Return<HolderMapView> {
  const { day, month, refused, days, focus, links, offList, mostHeld } = read
  if (focus === undefined)
    return { day, month, refused, days, focus: undefined, mostHeld }
  const bands: Array<BandSection> = []
  if (day !== undefined) bands.push(yield* section("5%", day, links))
  if (month !== undefined) bands.push(yield* section("1%", month, links))
  const earlier = [...offList].sort(
    (a, b) => b.since.localeCompare(a.since) || a.name.localeCompare(b.name)
  )
  const graph = yield* graphOf(focus.code, day ?? month, bands, earlier)
  return {
    day,
    month,
    refused,
    days,
    focus: {
      code: focus.code,
      issuerName: focus.issuerName,
      bands,
      graph,
      legend: yield* legendOf(graph.nodes, graph.links),
      offList: earlier,
    },
    mostHeld,
  }
})
