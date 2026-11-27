// The Holder map's view model (spec apinrdw/kumora#733, "View model"): the
// read turned into what the page shows, the focus's side panel, a section
// per band, and the graph's nodes, links and legend, or the landing view's
// stocks.
import type { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { HolderKey, type KseiType } from "@/domain/holdings"
import type {
  HolderMapLink,
  HolderMapOffList,
  HolderMapRead,
} from "@/server/holdings/holder-map"

export type Band = HolderMapLink["band"]

type Origin = HolderMapLink["origin"]

// What a holding shows, and the graph colours its link by: its crossing of
// 5% between the bands' periods, else its stored move, else Unchanged.
export type ShownMove =
  | NonNullable<HolderMapLink["move"]>["kind"]
  | NonNullable<HolderMapLink["crossing"]>["kind"]
  | "unchanged"

// A holding as the side panel lists it: a stock focus's holder, or a
// holder focus's stock.
export interface MapHolder extends HolderMapLink {
  readonly shownMove: ShownMove
  // Its stock's, as the report prints it.
  readonly issuerName: string | undefined
}

// What a link shows: its holding's move, or Off list for one that left.
export type LinkMove = ShownMove | "off list"

// A node's move, as its tooltip names it.
export type NodeMove =
  | {
      readonly kind: ShownMove
      // Its % of the stock's change × 100; undefined when none is stored.
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
  // Most % first, then by name and stock.
  readonly holders: ReadonlyArray<MapHolder>
  // Their summed % × 100.
  readonly totalHundredths: number
}

// The search a node's click navigates to. A custodian gains one with
// custodian focus (apinrdw/kumora#739).
export type Refocus =
  | { readonly stock: StockCode }
  | { readonly holder: HolderKey }

// One dot of the graph.
export interface MapNode {
  // `stock:<code>` or `holder:<holder key>`: unique in the graph, stable
  // across reloads.
  readonly id: string
  readonly kind: "stock" | "holder"
  // A stock's code; a holder's name as published.
  readonly name: string
  // A stock's issuer name; undefined on a holder.
  readonly issuerName: string | undefined
  // The name shortened for a label beside the dot.
  readonly label: string
  // What the dot prints inside: a stock's code, a holder's KSEI type.
  readonly inside: string | undefined
  // Its holding's band, filled or outlined; undefined on the focus and a
  // stock of the outer ring.
  readonly band: Band | undefined
  readonly origin: Origin
  readonly investorType: KseiType | undefined
  // The holding its stake is of: a holder's of a stock, or a holder
  // focus's of a stock; undefined on a stock focus and its outer ring.
  readonly holding:
    | { readonly code: StockCode; readonly holderName: string }
    | undefined
  // That holding's % × 100.
  readonly stakeHundredths: number | undefined
  readonly shares: number | undefined
  // In layout units, following the stake.
  readonly radius: number
  readonly focus: boolean
  // A holding the focus left: drawn faded and dashed, hidden by the Off
  // list toggle.
  readonly offList: boolean
  // Its holding's; undefined without one.
  readonly move: NodeMove | undefined
  // Always labelled: the focus and its direct neighbours. Any other node is
  // labelled only while hovered.
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
  // What its holding's row shows, the link's colour.
  readonly move: LinkMove
}

export type LegendEntry =
  | {
      readonly kind: "node" | "band" | "origin"
      readonly key: string
      readonly label: string
    }
  | { readonly kind: "move"; readonly key: LinkMove; readonly label: string }

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
) & {
  // What the map is of: a stock's code, a holder's name, else its key.
  readonly title: string
  // The 5% band, then the 1% band; the 5% band only for a day before any
  // above-1% month, none for a refused day.
  readonly bands: ReadonlyArray<BandSection>
  // The focus first, then the side panel's holdings in its order, the Off
  // list, then the second hop.
  readonly graph: {
    // The focus and the day it is drawn as of: the layout's key, so a
    // reload of one focus and day lays out the same picture.
    readonly key: string
    readonly nodes: ReadonlyArray<MapNode>
    readonly links: ReadonlyArray<MapLink>
  }
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

// The focus's radius, a holder's at 0%, plus its growth with the square
// root of its %, so a dot's area follows the stake. A stock of the outer
// ring or a holder focus's stock is at least big enough for its code.
const FOCUS_RADIUS = 22
const HOLDER_RADIUS = 5
const STOCK_RADIUS = 12
const RADIUS_PER_ROOT_PERCENT = 2
// A link's width at 0% and per %.
const LINK_WIDTH = 0.6
const WIDTH_PER_PERCENT = 0.12

const section = (
  band: Band,
  date: WibDate | undefined,
  links: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) =>
  Effect.sync((): BandSection => {
    const holders = links
      .filter((link) => link.band === band)
      .map((link): MapHolder => ({
        ...link,
        shownMove: shownMoveOf(link),
        issuerName: issuers.get(link.code),
      }))
      .sort(
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
    }
  })

const shownMoveOf = (link: HolderMapLink): ShownMove =>
  link.crossing?.kind ?? link.move?.kind ?? "unchanged"

const labelOf = (name: string) =>
  name.length > LABEL_LENGTH ? `${name.slice(0, LABEL_LENGTH)}…` : name

// A node's radius and a link's width, following the %.
const radiusOf = (hundredths: number) =>
  HOLDER_RADIUS + RADIUS_PER_ROOT_PERCENT * Math.sqrt(hundredths / 100)
const widthOf = (hundredths: number) =>
  LINK_WIDTH + (WIDTH_PER_PERCENT * hundredths) / 100

const stockId = (code: string) => `stock:${code}`
const holderId = (key: string) => `holder:${key}`

// A node with nothing drawn on it yet but its kind, id and name.
const bare = (
  kind: MapNode["kind"],
  name: string,
  refocus: Refocus
): MapNode => ({
  id: kind === "stock" ? stockId(name) : holderId(name),
  kind,
  name,
  issuerName: undefined,
  label: labelOf(name),
  inside: kind === "stock" ? name : undefined,
  band: undefined,
  origin: undefined,
  investorType: undefined,
  holding: undefined,
  stakeHundredths: undefined,
  shares: undefined,
  radius: kind === "stock" ? STOCK_RADIUS : HOLDER_RADIUS,
  focus: false,
  offList: false,
  move: undefined,
  labelled: false,
  refocus,
})

const stockNode = (code: StockCode, issuers: ReadonlyMap<StockCode, string>) =>
  ({
    ...bare("stock", code, { stock: code }),
    issuerName: issuers.get(code),
  }) satisfies MapNode

// A holding's node at its other end: a holder of a stock, or a stock of a
// holder.
const heldNode = (
  link: HolderMapLink,
  end: "holder" | "stock",
  issuers: ReadonlyMap<StockCode, string>
): MapNode => {
  const base =
    end === "holder"
      ? {
          ...bare("holder", link.holder, {
            holder: HolderKey.make(link.holder),
          }),
          name: link.name,
          label: labelOf(link.name),
          inside: link.investorType,
          origin: link.origin,
          investorType: link.investorType,
          radius: radiusOf(link.percentageHundredths),
        }
      : {
          ...stockNode(link.code, issuers),
          radius: Math.max(STOCK_RADIUS, radiusOf(link.percentageHundredths)),
        }
  return {
    ...base,
    band: link.band,
    holding: { code: link.code, holderName: link.name },
    stakeHundredths: link.percentageHundredths,
    shares: link.shares,
    move: {
      kind: shownMoveOf(link),
      percentageChange: link.move?.percentageChange,
    },
  }
}

// A holding the focus left, labelled only while hovered: it no longer
// holds.
const offListNode = (
  left: HolderMapOffList,
  end: "holder" | "stock",
  issuers: ReadonlyMap<StockCode, string>
): MapNode => ({
  ...(end === "holder"
    ? {
        ...bare("holder", left.holder, { holder: HolderKey.make(left.holder) }),
        name: left.name,
        label: labelOf(left.name),
      }
    : stockNode(left.code, issuers)),
  inside: end === "stock" ? left.code : undefined,
  band: left.band,
  holding: { code: left.code, holderName: left.name },
  stakeHundredths: left.percentageHundredths,
  radius: end === "stock" ? STOCK_RADIUS : radiusOf(left.percentageHundredths),
  offList: true,
  move: { kind: "off list", band: left.band, since: left.since },
})

const linkOf = (
  source: string,
  target: string,
  band: Band,
  hundredths: number,
  move: LinkMove
): MapLink => ({
  id: `${source}->${target}`,
  source,
  target,
  band,
  stakeHundredths: hundredths,
  width: widthOf(hundredths),
  move,
})

const holdingLink = (link: HolderMapLink, from: "stock" | "holder"): MapLink =>
  from === "stock"
    ? linkOf(
        stockId(link.code),
        holderId(link.holder),
        link.band,
        link.percentageHundredths,
        shownMoveOf(link)
      )
    : linkOf(
        holderId(link.holder),
        stockId(link.code),
        link.band,
        link.percentageHundredths,
        shownMoveOf(link)
      )

// The second hop's far nodes, one each however many links reach it: a
// stock focus's holders' other stocks, by code, or a holder focus's
// stocks' other holders, by key, each drawn at its largest holding.
const outerNodes = (
  hops: ReadonlyArray<HolderMapLink>,
  end: "holder" | "stock",
  issuers: ReadonlyMap<StockCode, string>
) => {
  const largest = new Map<string, HolderMapLink>()
  for (const hop of hops) {
    const id = end === "stock" ? stockId(hop.code) : holderId(hop.holder)
    const known = largest.get(id)
    if (
      known === undefined ||
      hop.percentageHundredths > known.percentageHundredths
    )
      largest.set(id, hop)
  }
  return [...largest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, hop]) =>
      end === "stock"
        ? stockNode(hop.code, issuers)
        : heldNode(hop, end, issuers)
    )
}

const byPlace = (a: HolderMapLink, b: HolderMapLink) =>
  a.code.localeCompare(b.code) || a.holder.localeCompare(b.holder)

const graphOf = (
  focus: FocusView,
  asOf: WibDate | undefined,
  bands: ReadonlyArray<BandSection>,
  offList: ReadonlyArray<HolderMapOffList>,
  hops: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) =>
  Effect.sync(() => {
    const holdings = bands.flatMap((band) => band.holders)
    // A stock focus's holdings are its holders; a holder focus's its stocks.
    const near = focus.kind === "stock" ? "holder" : "stock"
    const far = focus.kind === "stock" ? "stock" : "holder"
    const head: MapNode =
      focus.kind === "stock"
        ? {
            ...stockNode(focus.code, issuers),
            issuerName: focus.issuerName,
            radius: FOCUS_RADIUS,
            focus: true,
            labelled: true,
          }
        : {
            ...bare("holder", focus.key, { holder: focus.key }),
            name: focus.title,
            label: labelOf(focus.title),
            inside: holdings[0]?.investorType,
            origin: holdings[0]?.origin,
            investorType: holdings[0]?.investorType,
            radius: FOCUS_RADIUS,
            focus: true,
            labelled: true,
          }
    const nodes: Array<MapNode> = [head]
    for (const holding of holdings)
      nodes.push({ ...heldNode(holding, near, issuers), labelled: true })
    for (const left of offList) nodes.push(offListNode(left, near, issuers))
    const ordered = [...hops].sort(byPlace)
    nodes.push(...outerNodes(ordered, far, issuers))
    const links = [
      ...holdings.map((holding) => holdingLink(holding, focus.kind)),
      // Off list: no longer a holding, so its link is drawn at 0%.
      ...offList.map((left) => {
        const end =
          near === "holder" ? holderId(left.holder) : stockId(left.code)
        return linkOf(head.id, end, left.band, 0, "off list")
      }),
      ...ordered.map((hop) => holdingLink(hop, near)),
    ]
    return { key: `${head.id}@${asOf ?? ""}`, nodes, links }
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
    const drawn = nodes.filter(({ offList }) => !offList)
    const holders = drawn.filter(({ kind }) => kind === "holder")
    const kinds: Array<LegendEntry> = [
      { kind: "node", key: "stock", label: "Stock" },
      ...(holders.length > 0
        ? [{ kind: "node" as const, key: "holder", label: "Holder" }]
        : []),
    ]
    const bands = (["5%", "1%"] as const)
      .filter((band) => drawn.some((node) => node.band === band))
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

// The focus as the page names it.
const focusOf = (focus: NonNullable<HolderMapRead["focus"]>) =>
  Effect.sync(() =>
    focus.kind === "stock"
      ? {
          kind: "stock" as const,
          code: focus.code,
          issuerName: focus.issuerName,
          title: focus.code as string,
        }
      : {
          kind: "holder" as const,
          key: HolderKey.make(focus.key),
          name: focus.name,
          title: focus.name ?? focus.key,
        }
  )

export const holderMapView = Effect.fnUntraced(function* (
  read: HolderMapRead
): Effect.fn.Return<HolderMapView> {
  const { day, month, refused, days, focus, links, hops, offList } = read
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
  if (day !== undefined) bands.push(yield* section("5%", day, links, issuers))
  if (month !== undefined)
    bands.push(yield* section("1%", month, links, issuers))
  const earlier = [...offList].sort(
    (a, b) =>
      b.since.localeCompare(a.since) ||
      a.name.localeCompare(b.name) ||
      a.code.localeCompare(b.code)
  )
  const named = yield* focusOf(focus)
  const partial = {
    ...named,
    bands,
    graph: { key: "", nodes: [], links: [] },
    legend: [],
    offList: earlier,
  } satisfies FocusView
  const graph = yield* graphOf(
    partial,
    day ?? month,
    bands,
    earlier,
    hops,
    issuers
  )
  return {
    day,
    month,
    refused,
    days,
    focus: {
      ...partial,
      graph,
      legend: yield* legendOf(graph.nodes, graph.links),
    },
    mostHeld: read.mostHeld,
  }
})
