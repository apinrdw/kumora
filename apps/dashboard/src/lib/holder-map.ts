// The Holder map's view model (spec apinrdw/kumora#733, "View model"): the
// read turned into what the page shows, the focus's side panel, a section
// per band, its custodians and a custodian focus's book, and the graph's
// nodes, links and legend, or the landing view's stocks.
import type { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { type CustodianId, HolderKey, type KseiType } from "@/domain/holdings"
import type {
  HolderMapCustodianLink,
  HolderMapLink,
  HolderMapOffList,
  HolderMapRead,
} from "@/server/holdings/holder-map-schema"

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

// The search a node's click navigates to.
export type Refocus =
  | { readonly stock: StockCode }
  | { readonly holder: HolderKey }
  | { readonly custodian: CustodianId }

// One dot of the graph.
export interface MapNode {
  // `stock:<code>`, `holder:<holder key>` or `custodian:<id>`: unique in
  // the graph, stable across reloads.
  readonly id: string
  readonly kind: "stock" | "holder" | "custodian"
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
  // labelled only while hovered.
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
  // The custodians the graph draws, but the focus; most shares first.
  readonly custodians: ReadonlyArray<MapCustodian>
  // The focus first, then the side panel's holdings in its order, the Off
  // list, the second hop, then the custodians.
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
const custodianId = (id: string) => `custodian:${id}`

// A node with nothing drawn on it yet but its kind, id and name.
const bare = (
  kind: MapNode["kind"],
  name: string,
  refocus: Refocus
): MapNode => ({
  id: `${kind}:${name}`,
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
  radius: kind === "holder" ? HOLDER_RADIUS : STOCK_RADIUS,
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
  move: LinkMove | undefined
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

const placeOf = (code: string, holder: string) => `${code} ${holder}`

// A custodian's node: its broker code inside, unlabelled but as the focus.
const custodianNode = (custodian: MapCustodian): MapNode => ({
  ...bare("custodian", custodian.id, { custodian: custodian.id }),
  name: custodian.name,
  label: labelOf(custodian.name),
  inside: custodian.broker,
  shares: custodian.shares,
})

// The custodians of `links`, each once, by id.
const custodiansOf = (links: ReadonlyArray<HolderMapCustodianLink>) =>
  Effect.sync((): ReadonlyArray<MapCustodian> => {
    const byId = new Map<
      CustodianId,
      { custodian: MapCustodian; holders: Set<string> }
    >()
    for (const link of links) {
      const known = byId.get(link.custodian)
      const holders = known?.holders ?? new Set<string>()
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

// One link a custodian and holder, however many stocks the holder holds
// there: the % of each stock its shares there are, summed.
const custodianLinksOf = (
  custodians: ReadonlyArray<HolderMapCustodianLink>,
  holdings: ReadonlyArray<HolderMapLink>
) =>
  Effect.sync(() => {
    const held = new Map(
      holdings.map((holding) => [
        placeOf(holding.code, holding.holder),
        holding,
      ])
    )
    const stakes = new Map<
      string,
      { source: string; target: string; hundredths: number }
    >()
    for (const link of custodians) {
      const holding = held.get(placeOf(link.code, link.holder))
      const hundredths =
        holding === undefined || holding.shares === 0
          ? 0
          : (holding.percentageHundredths * link.shares) / holding.shares
      const source = custodianId(link.custodian)
      const target = holderId(link.holder)
      const id = `${source}->${target}`
      stakes.set(id, {
        source,
        target,
        hundredths: (stakes.get(id)?.hundredths ?? 0) + hundredths,
      })
    }
    return [...stakes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { source, target, hundredths }]) =>
        linkOf(source, target, "5%", hundredths, undefined)
      )
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
      string,
      { shares: number; stocks: Set<StockCode> }
    >()
    const stocks = new Map<
      StockCode,
      { shares: number; holders: Set<string> }
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
        holders: new Set<string>(),
      }
      stock.shares += link.shares
      stock.holders.add(link.holder)
      stocks.set(link.code, stock)
    }
    return {
      holders: [...holders]
        .map(([key, { shares, stocks: of }]) => ({
          key: HolderKey.make(key),
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

// A custodian focus's graph: the focus, its holders each once at their
// largest holding through it, then the stocks they hold through it.
const custodianGraph = (
  head: MapNode,
  book: CustodianBook,
  holdings: ReadonlyArray<HolderMapLink>,
  issuers: ReadonlyMap<StockCode, string>
) =>
  Effect.sync(() => {
    const largest = new Map<string, HolderMapLink>()
    for (const holding of holdings) {
      const known = largest.get(holding.holder)
      if (
        known === undefined ||
        holding.percentageHundredths > known.percentageHundredths
      )
        largest.set(holding.holder, holding)
    }
    const nodes: Array<MapNode> = [head]
    for (const { key } of book.holders) {
      const holding = largest.get(key)
      if (holding !== undefined)
        nodes.push({ ...heldNode(holding, "holder", issuers), labelled: true })
    }
    const ordered = [...holdings].sort(byPlace)
    for (const stock of new Set(ordered.map((held) => held.code)))
      nodes.push(stockNode(stock, issuers))
    return {
      nodes,
      links: ordered.map((holding) => holdingLink(holding, "holder")),
    }
  })

// The graph's first nodes and links: the focus and its hops.
const hopsGraph = (
  focus: Exclude<FocusView, { kind: "custodian" }>,
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
    return { nodes, links }
  })

const graphOf = Effect.fnUntraced(function* (
  focus: FocusView,
  asOf: WibDate | undefined,
  read: Pick<HolderMapRead, "links" | "hops" | "custodians">,
  offList: ReadonlyArray<HolderMapOffList>,
  issuers: ReadonlyMap<StockCode, string>
) {
  const { nodes, links } =
    focus.kind === "custodian"
      ? yield* custodianGraph(
          {
            ...custodianNode({
              id: focus.id,
              broker: focus.broker,
              name: focus.title,
              shares: focus.book.holders.reduce(
                (sum, { shares }) => sum + shares,
                0
              ),
              holders: focus.book.holders.length,
            }),
            radius: FOCUS_RADIUS,
            focus: true,
            labelled: true,
          },
          focus.book,
          read.links,
          issuers
        )
      : yield* hopsGraph(focus, focus.bands, offList, read.hops, issuers)
  const [head] = nodes
  return {
    key: `${head?.id ?? ""}@${asOf ?? ""}`,
    // The custodians after the rest, by id: the layout's stable order.
    nodes: [
      ...nodes,
      ...[...focus.custodians]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(custodianNode),
    ],
    links: [
      ...links,
      ...(yield* custodianLinksOf(read.custodians, [
        ...read.links,
        ...read.hops,
      ])),
    ],
  }
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
      ...(drawn.some(({ kind }) => kind === "custodian")
        ? [{ kind: "node" as const, key: "custodian", label: "Custodian" }]
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
      key: HolderKey.make(focus.key),
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
  const partial = {
    ...named,
    bands,
    custodians: (yield* custodiansOf(read.custodians)).filter(
      ({ id }) => focus.kind !== "custodian" || id !== focus.id
    ),
    graph: { key: "", nodes: [], links: [] },
    legend: [],
    offList: earlier,
  } satisfies FocusView
  const graph = yield* graphOf(partial, day ?? month, read, earlier, issuers)
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
