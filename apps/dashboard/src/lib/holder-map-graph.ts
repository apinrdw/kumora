// The Holder map's graph (spec apinrdw/kumora#733, "View model"): the
// read's holdings as the nodes and links the map draws, and the legend of
// what it draws.
import type { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import type { CustodianId, HolderKey, KseiType } from "@/domain/holdings"
import type {
  HolderMapCustodianLink,
  HolderMapLink,
  HolderMapOffList,
} from "@/server/holdings/holder-map-schema"

import { type NodeKind, nodeId, placeOf } from "./holder-map-ids"

export type Band = HolderMapLink["band"]

type Origin = HolderMapLink["origin"]

// What a holding shows, and the graph colours its link by: its crossing of
// 5% between the bands' periods, else its stored move, else Unchanged.
export type ShownMove =
  | NonNullable<HolderMapLink["move"]>["kind"]
  | NonNullable<HolderMapLink["crossing"]>["kind"]
  | "unchanged"

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

// The search a node's click navigates to.
export type Refocus =
  | { readonly stock: StockCode }
  | { readonly holder: HolderKey }
  | { readonly custodian: CustodianId }

// One dot of the graph.
export interface MapNode {
  // `nodeId` of its kind and key: unique in the graph, stable across
  // reloads.
  readonly id: string
  readonly kind: NodeKind
  // A stock's code; a holder's name as published; a custodian's name.
  readonly name: string
  // A stock's issuer name; undefined on a holder.
  readonly issuerName: string | undefined
  // The name shortened for a label beside the dot.
  readonly label: string
  // What the dot prints inside: a stock's code, a holder's KSEI type, a
  // custodian's broker code.
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
  // Its holding's; a custodian's, its links' summed.
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
  // labelled only while hovered or searched.
  readonly labelled: boolean
  readonly refocus: Refocus | undefined
}

// One line between two nodes: a holding, or a holder's shares at a
// custodian.
export interface MapLink {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly band: Band
  // A custodian link's: the % its shares there are of each stock, summed.
  readonly stakeHundredths: number
  // In layout units, following the stake.
  readonly width: number
  // What its holding's row shows, the link's colour; undefined on a
  // custodian link.
  readonly move: LinkMove | undefined
}

export type LegendEntry =
  | {
      readonly kind: "node" | "band" | "origin"
      readonly key: string
      readonly label: string
    }
  | { readonly kind: "move"; readonly key: LinkMove; readonly label: string }

// A custodian the map draws, as its side panel lists it.
export interface MapCustodian {
  readonly id: CustodianId
  readonly broker: BrokerCode | undefined
  readonly name: string
  // Its links' shares, summed.
  readonly shares: number
  // The holders whose links they are.
  readonly holders: number
}

// What the graph is drawn around.
export type GraphFocus =
  | {
      readonly kind: "stock"
      readonly code: StockCode
      readonly issuerName: string | undefined
    }
  | {
      readonly kind: "holder"
      readonly key: HolderKey
      readonly title: string
    }
  | {
      readonly kind: "custodian"
      readonly id: CustodianId
      readonly broker: BrokerCode | undefined
      readonly title: string
      // Its book's holders, in the side panel's order.
      readonly holders: ReadonlyArray<{
        readonly key: HolderKey
        readonly shares: number
      }>
    }

export interface MapGraph {
  // The focus and the day it is drawn as of: one map across reloads, as a
  // search's pick is kept for. The layout is keyed on the nodes and links
  // (lib/holder-map-layout.ts, `layoutInputOf`).
  readonly key: string
  // The focus first, then the side panel's holdings in its order, the Off
  // list, the second hop, then the custodians.
  readonly nodes: ReadonlyArray<MapNode>
  readonly links: ReadonlyArray<MapLink>
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

// A bare node's radius, by kind.
const BARE_RADIUS: Record<NodeKind, number> = {
  stock: STOCK_RADIUS,
  holder: HOLDER_RADIUS,
  custodian: STOCK_RADIUS,
}

export const shownMoveOf = (link: HolderMapLink) =>
  Effect.succeed<ShownMove>(
    link.crossing?.kind ?? link.move?.kind ?? "unchanged"
  )

const labelOf = (name: string) =>
  Effect.succeed(
    name.length > LABEL_LENGTH ? `${name.slice(0, LABEL_LENGTH)}…` : name
  )

// A node's radius and a link's width, following the %.
const radiusOf = (hundredths: number) =>
  Effect.succeed(
    HOLDER_RADIUS + RADIUS_PER_ROOT_PERCENT * Math.sqrt(hundredths / 100)
  )
const widthOf = (hundredths: number) =>
  Effect.succeed(LINK_WIDTH + (WIDTH_PER_PERCENT * hundredths) / 100)

// A node with nothing drawn on it yet but its kind, id and name.
const bare = Effect.fnUntraced(function* (
  kind: NodeKind,
  key: string,
  name: string,
  refocus: Refocus
) {
  return {
    id: yield* nodeId(kind, key),
    kind,
    name,
    issuerName: undefined,
    label: yield* labelOf(name),
    inside: undefined,
    band: undefined,
    origin: undefined,
    investorType: undefined,
    holding: undefined,
    stakeHundredths: undefined,
    shares: undefined,
    radius: BARE_RADIUS[kind],
    focus: false,
    offList: false,
    move: undefined,
    labelled: false,
    refocus,
  } satisfies MapNode as MapNode
})

const stockNode = Effect.fnUntraced(function* (
  code: StockCode,
  issuers: ReadonlyMap<StockCode, string>
) {
  return {
    ...(yield* bare("stock", code, code, { stock: code })),
    issuerName: issuers.get(code),
    inside: code,
  } satisfies MapNode as MapNode
})

const holderNode = (holder: HolderKey, name: string) =>
  bare("holder", holder, name, { holder })

// A holding's node at its other end: a holder of a stock, or a stock of a
// holder.
const heldNode = Effect.fnUntraced(function* (
  link: HolderMapLink,
  end: "holder" | "stock",
  issuers: ReadonlyMap<StockCode, string>
) {
  const radius = yield* radiusOf(link.percentageHundredths)
  const base: MapNode =
    end === "holder"
      ? {
          ...(yield* holderNode(link.holder, link.name)),
          inside: link.investorType,
          origin: link.origin,
          investorType: link.investorType,
          radius,
        }
      : {
          ...(yield* stockNode(link.code, issuers)),
          radius: Math.max(STOCK_RADIUS, radius),
        }
  return {
    ...base,
    band: link.band,
    holding: { code: link.code, holderName: link.name },
    stakeHundredths: link.percentageHundredths,
    shares: link.shares,
    move: {
      kind: yield* shownMoveOf(link),
      percentageChange: link.move?.percentageChange,
    },
  } satisfies MapNode as MapNode
})

// A holding the focus left, labelled only while hovered: it no longer
// holds.
const offListNode = Effect.fnUntraced(function* (
  left: HolderMapOffList,
  end: "holder" | "stock",
  issuers: ReadonlyMap<StockCode, string>
) {
  return {
    ...(end === "holder"
      ? {
          ...(yield* holderNode(left.holder, left.name)),
          radius: yield* radiusOf(left.percentageHundredths),
        }
      : yield* stockNode(left.code, issuers)),
    band: left.band,
    holding: { code: left.code, holderName: left.name },
    stakeHundredths: left.percentageHundredths,
    offList: true,
    move: { kind: "off list", band: left.band, since: left.since },
  } satisfies MapNode as MapNode
})

const linkOf = Effect.fnUntraced(function* (
  source: string,
  target: string,
  band: Band,
  hundredths: number,
  move: LinkMove | undefined
) {
  return {
    id: `${source}->${target}`,
    source,
    target,
    band,
    stakeHundredths: hundredths,
    width: yield* widthOf(hundredths),
    move,
  } satisfies MapLink as MapLink
})

// A holding's link, from its stock or from its holder.
const holdingLink = Effect.fnUntraced(function* (
  link: HolderMapLink,
  from: "stock" | "holder"
) {
  const stock = yield* nodeId("stock", link.code)
  const holder = yield* nodeId("holder", link.holder)
  const [source, target] = from === "stock" ? [stock, holder] : [holder, stock]
  return yield* linkOf(
    source,
    target,
    link.band,
    link.percentageHundredths,
    yield* shownMoveOf(link)
  )
})

// Each holding's node id at `end`, its largest holding kept: the hop
// beyond's one node however many links reach it.
const largestBy = Effect.fnUntraced(function* (
  holdings: ReadonlyArray<HolderMapLink>,
  end: "holder" | "stock"
) {
  const largest = new Map<string, HolderMapLink>()
  for (const holding of holdings) {
    const id = yield* nodeId(
      end,
      end === "stock" ? holding.code : holding.holder
    )
    const known = largest.get(id)
    if (
      known === undefined ||
      holding.percentageHundredths > known.percentageHundredths
    )
      largest.set(id, holding)
  }
  return largest
})

// The second hop's far nodes, one each by id: a stock focus's holders'
// other stocks, or a holder focus's stocks' other holders, each drawn at
// its largest holding.
const outerNodes = Effect.fnUntraced(function* (
  hops: ReadonlyArray<HolderMapLink>,
  end: "holder" | "stock",
  issuers: ReadonlyMap<StockCode, string>
) {
  const nodes: Array<MapNode> = []
  const largest = [...(yield* largestBy(hops, end))].sort(([a], [b]) =>
    a.localeCompare(b)
  )
  for (const [, hop] of largest)
    nodes.push(
      end === "stock"
        ? yield* stockNode(hop.code, issuers)
        : yield* heldNode(hop, end, issuers)
    )
  return nodes
})

const byPlace = (holdings: ReadonlyArray<HolderMapLink>) =>
  Effect.sync(() =>
    [...holdings].sort(
      (a, b) => a.code.localeCompare(b.code) || a.holder.localeCompare(b.holder)
    )
  )

// A custodian's node: its broker code inside, unlabelled but as the focus.
const custodianNode = Effect.fnUntraced(function* (custodian: MapCustodian) {
  return {
    ...(yield* bare("custodian", custodian.id, custodian.name, {
      custodian: custodian.id,
    })),
    inside: custodian.broker,
    shares: custodian.shares,
  } satisfies MapNode as MapNode
})

// One link a custodian and holder, however many stocks the holder holds
// there: the % of each stock its shares there are, summed.
const custodianLinksOf = Effect.fnUntraced(function* (
  custodians: ReadonlyArray<HolderMapCustodianLink>,
  holdings: ReadonlyArray<HolderMapLink>
) {
  const held = new Map<string, HolderMapLink>()
  for (const holding of holdings)
    held.set(yield* placeOf(holding.code, holding.holder), holding)
  const stakes = new Map<
    string,
    { source: string; target: string; hundredths: number }
  >()
  for (const link of custodians) {
    const holding = held.get(yield* placeOf(link.code, link.holder))
    const hundredths =
      holding === undefined || holding.shares === 0
        ? 0
        : (holding.percentageHundredths * link.shares) / holding.shares
    const source = yield* nodeId("custodian", link.custodian)
    const target = yield* nodeId("holder", link.holder)
    const id = `${source}->${target}`
    stakes.set(id, {
      source,
      target,
      hundredths: (stakes.get(id)?.hundredths ?? 0) + hundredths,
    })
  }
  const links: Array<MapLink> = []
  for (const [, { source, target, hundredths }] of [...stakes].sort(
    ([a], [b]) => a.localeCompare(b)
  ))
    links.push(yield* linkOf(source, target, "5%", hundredths, undefined))
  return links
})

export interface GraphInput {
  readonly focus: GraphFocus
  readonly asOf: WibDate | undefined
  // The first hop in the side panel's order: a stock focus's holders, a
  // holder focus's stocks, a custodian focus's holdings through it.
  readonly holdings: ReadonlyArray<HolderMapLink>
  // In the side panel's order.
  readonly offList: ReadonlyArray<HolderMapOffList>
  readonly hops: ReadonlyArray<HolderMapLink>
  // The custodians drawn but the focus, and their links.
  readonly custodians: ReadonlyArray<MapCustodian>
  readonly custodianLinks: ReadonlyArray<HolderMapCustodianLink>
  readonly issuers: ReadonlyMap<StockCode, string>
}

// The focus's node.
const headOf = Effect.fnUntraced(function* (
  focus: GraphFocus,
  holdings: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) {
  const head: MapNode =
    focus.kind === "stock"
      ? {
          ...(yield* stockNode(focus.code, issuers)),
          issuerName: focus.issuerName,
        }
      : focus.kind === "holder"
        ? {
            ...(yield* holderNode(focus.key, focus.title)),
            inside: holdings[0]?.investorType,
            origin: holdings[0]?.origin,
            investorType: holdings[0]?.investorType,
          }
        : yield* custodianNode({
            id: focus.id,
            broker: focus.broker,
            name: focus.title,
            shares: focus.holders.reduce((sum, { shares }) => sum + shares, 0),
            holders: focus.holders.length,
          })
  return {
    ...head,
    radius: FOCUS_RADIUS,
    focus: true,
    labelled: true,
  } satisfies MapNode as MapNode
})

// Which end of a holding each hop draws, by focus: a stock focus's first
// hop is holders and its second stocks, a holder focus's the other way,
// and a custodian focus's holders, then the stocks they hold through it.
const ENDS: Record<
  GraphFocus["kind"],
  { readonly near: "holder" | "stock"; readonly far: "holder" | "stock" }
> = {
  stock: { near: "holder", far: "stock" },
  holder: { near: "stock", far: "holder" },
  custodian: { near: "holder", far: "stock" },
}

// The focus and its hops: the first hop, each once at its largest holding,
// the Off list, then the hop beyond. A custodian focus's hop beyond is the
// stocks of its holdings, and the links its holdings.
const hopsGraph = Effect.fnUntraced(function* (
  head: MapNode,
  input: GraphInput
) {
  const { focus, holdings, offList, hops, issuers } = input
  const { near, far } = ENDS[focus.kind]
  const nodes: Array<MapNode> = [head]
  const links: Array<MapLink> = []
  if (focus.kind === "custodian") {
    const largest = yield* largestBy(holdings, near)
    for (const { key } of focus.holders) {
      const holding = largest.get(yield* nodeId("holder", key))
      if (holding !== undefined)
        nodes.push({
          ...(yield* heldNode(holding, near, issuers)),
          labelled: true,
        })
    }
  } else
    for (const holding of holdings) {
      nodes.push({
        ...(yield* heldNode(holding, near, issuers)),
        labelled: true,
      })
      links.push(yield* holdingLink(holding, focus.kind))
    }
  // A custodian's Off list is by holding: a holder drawn already, as still
  // holding through it or as left in another stock, is drawn once.
  const drawn = new Set(nodes.map(({ id }) => id))
  for (const left of offList) {
    const node = yield* offListNode(left, near, issuers)
    if (drawn.has(node.id)) continue
    drawn.add(node.id)
    nodes.push(node)
    // Off list: no longer a holding, so its link is drawn at 0%.
    links.push(yield* linkOf(head.id, node.id, left.band, 0, "off list"))
  }
  const beyond = yield* byPlace(focus.kind === "custodian" ? holdings : hops)
  nodes.push(...(yield* outerNodes(beyond, far, issuers)))
  for (const hop of beyond) links.push(yield* holdingLink(hop, near))
  return { nodes, links }
})

export const graphOf = Effect.fnUntraced(function* (
  input: GraphInput
): Effect.fn.Return<MapGraph> {
  const head = yield* headOf(input.focus, input.holdings, input.issuers)
  const { nodes, links } = yield* hopsGraph(head, input)
  // The custodians after the rest, by id: the layout's stable order.
  for (const custodian of [...input.custodians].sort((a, b) =>
    a.id.localeCompare(b.id)
  ))
    nodes.push(yield* custodianNode(custodian))
  links.push(
    ...(yield* custodianLinksOf(input.custodianLinks, [
      ...input.holdings,
      ...input.hops,
    ]))
  )
  return { key: `${head.id}@${input.asOf ?? ""}`, nodes, links }
})

const ORIGIN_ORDER = ["local", "foreign", "mixed", undefined] as const

const NODE_LABEL: Record<NodeKind, string> = {
  stock: "Stock",
  holder: "Holder",
  custodian: "Custodian",
}

// In the legend's order, only what the graph draws. Off list nodes don't
// count toward its kinds, bands or origins.
export const legendOf = Effect.fnUntraced(function* (graph: MapGraph) {
  const drawn = graph.nodes.filter(({ offList }) => !offList)
  const holders = drawn.filter(({ kind }) => kind === "holder")
  const kinds = (["stock", "holder", "custodian"] as const)
    .filter(
      (kind) => kind === "stock" || drawn.some((node) => node.kind === kind)
    )
    .map((kind): LegendEntry => ({
      kind: "node",
      key: kind,
      label: NODE_LABEL[kind],
    }))
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
    .filter((move) => graph.links.some((each) => each.move === move))
    .map((move): LegendEntry => ({
      kind: "move",
      key: move,
      label: MOVE_LABEL[move],
    }))
  return [
    ...kinds,
    ...bands,
    ...origins,
    ...moves,
  ] as ReadonlyArray<LegendEntry>
})
