// The Holder map's chart definition: links and dots on Canvas, the codes
// inside the dots and the labels beside them in SVG, over the viewport's x
// and y domains.
import { defineChart, dot, link, text } from "@tanstack/charts"
import { canvasChartRenderer } from "@tanstack/charts/canvas"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { portal } from "@tanstack/charts/tooltip/portal"
import { Effect } from "effect"

import { percentChangeText, percentOf } from "@/components/stocks/holder-cells"
import { KSEI_TYPE_LABELS } from "@/domain/holdings"
import { lotsOfShares } from "@/lib/format"
import type { HolderMapView } from "@/lib/holder-map"
import {
  type LinkMove,
  type MapNode,
  MOVE_LABEL,
  type NodeMove,
  ORIGIN_LABEL,
} from "@/lib/holder-map-graph"
import type { Layout } from "@/lib/holder-map-layout"
import { type Viewport, viewportDomains } from "@/lib/holder-map-viewport"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"

type Graph = NonNullable<HolderMapView["focus"]>["graph"]

// A dot prints its code or type inside only from this radius in px.
const INSIDE_FROM = 10
// A stock's dot is never drawn smaller than this in px, the room its
// four-letter code takes at the 10 px it is printed in, so an outer-ring
// stock's code reads on a map fitted to view however many nodes it has
// (spec apinrdw/kumora#733, story 27).
const CODE_RADIUS = 13

export const ORIGIN_COLOR: Record<
  NonNullable<MapNode["origin"]> | "unknown",
  string
> = {
  local: "var(--origin-local)",
  foreign: "var(--origin-foreign)",
  mixed: "var(--text-secondary)",
  unknown: "var(--text-muted)",
}
export const STOCK_COLOR = "var(--accent-primary)"
// A custodian's dot and its links to the holders it holds for.
export const CUSTODIAN_COLOR = "var(--semantic-warning)"
// A link's colour by its holder's move: Holder moves' tones, a crossing of
// 5% toned as the Up or Down it is.
export const MOVE_COLOR: Record<LinkMove, string> = {
  new: "var(--semantic-info)",
  up: "var(--semantic-up)",
  down: "var(--semantic-down)",
  transfer: "var(--text-secondary)",
  unchanged: "var(--text-muted)",
  "up into 5%": "var(--semantic-up)",
  "down out of 5%": "var(--semantic-down)",
  "off list": "var(--semantic-neutral)",
}
const SURFACE = "var(--bg-surface)"

// A node placed, its radius in px and its colour.
type NodeRow = MapNode & { x: number; y: number; r: number; color: string }

// A holder's move: its label and change, or the period it left the list.
const moveText = Effect.fnUntraced(function* (move: NodeMove) {
  if (move.kind === "off list")
    return `Off list since ${yield* move.band === "5%" ? dayDateLabel(move.since) : monthLabel(move.since)}`
  return move.percentageChange === undefined
    ? MOVE_LABEL[move.kind]
    : `${MOVE_LABEL[move.kind]} ${yield* percentChangeText(move.percentageChange)}`
})

// A node's holding: a holder's % of a stock, or a stock's held by a holder.
const stakeText = Effect.fnUntraced(function* (node: MapNode) {
  if (node.stakeHundredths === undefined || node.holding === undefined)
    return undefined
  const of =
    node.kind === "stock"
      ? `held by ${node.holding.holderName}`
      : `of ${node.holding.code}`
  return `${yield* percentOf(node.stakeHundredths)} ${of}${node.offList ? " last" : ""}`
})

// A listed holder's origin and KSEI type; none for a stock, a custodian or
// an Off list holder, which no longer has them.
const metaText = (node: MapNode) =>
  Effect.sync(() =>
    node.kind !== "holder" || node.offList
      ? undefined
      : [
          node.origin === undefined
            ? "Origin unknown"
            : ORIGIN_LABEL[node.origin],
          node.investorType === undefined
            ? "Type unknown"
            : KSEI_TYPE_LABELS[node.investorType],
        ].join(" · ")
  )

// A node's tooltip: its name, its holding's stake, a holder's origin and
// type, and its move.
export const tooltipText = Effect.fnUntraced(function* (node: MapNode) {
  if (node.kind === "stock" && node.focus) return `${node.name} · focus stock`
  if (node.kind === "custodian")
    return [
      node.inside === undefined ? node.name : `${node.name} · ${node.inside}`,
      `Custodian of ${yield* lotsOfShares(node.shares ?? 0)} lots in view`,
    ].join("\n")
  const name =
    node.kind === "stock" && node.issuerName !== undefined
      ? `${node.name} · ${node.issuerName}`
      : node.name
  const lines = [
    name,
    yield* stakeText(node),
    yield* metaText(node),
    node.move === undefined ? undefined : yield* moveText(node.move),
  ]
  return lines.filter((line) => line !== undefined).join("\n")
})

const placed = (
  graph: Graph,
  layout: Layout,
  view: Viewport,
  showOffList: boolean
) =>
  Effect.sync(() => {
    const nodes = graph.nodes.flatMap((node): Array<NodeRow> => {
      const at = layout.positions[node.id]
      if (at === undefined || (node.offList && !showOffList)) return []
      const color = node.offList
        ? MOVE_COLOR["off list"]
        : node.kind === "stock"
          ? STOCK_COLOR
          : node.kind === "custodian"
            ? CUSTODIAN_COLOR
            : ORIGIN_COLOR[node.origin ?? "unknown"]
      const r = node.radius / view.unit
      return [
        {
          ...node,
          ...at,
          r: node.kind === "stock" ? Math.max(CODE_RADIUS, r) : r,
          color,
        },
      ]
    })
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const links = graph.links.flatMap((each) => {
      const source = byId.get(each.source)
      const target = byId.get(each.target)
      if (source === undefined || target === undefined) return []
      const ends = { x1: source.x, y1: source.y, x2: target.x, y2: target.y }
      return [{ ...each, ...ends, strokeWidth: each.width / view.unit }]
    })
    return { nodes, links }
  })

// Off list nodes and links: faded and dashed.
const OFF_LIST_DASH = "3 3"
const OFF_LIST_OPACITY = 0.5

// One dot mark per colour and band: a dot's fill and stroke are fixed per
// mark. The 5% band is filled and the 1% band outlined; an Off list holder
// outlined, faded and dashed.
const dots = (nodes: ReadonlyArray<NodeRow>) =>
  Effect.sync(() => {
    const groups = new Map<string, Array<NodeRow>>()
    for (const node of nodes) {
      const style = node.offList
        ? "off list"
        : node.band === "1%"
          ? "outlined"
          : "filled"
      const key = `${style} ${node.color}`
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [node])
      else group.push(node)
    }
    return [...groups.values()].map((rows) => {
      const offList = rows[0]?.offList === true
      const outlined = offList || rows[0]?.band === "1%"
      const color = rows[0]?.color ?? STOCK_COLOR
      // Its ring is drawn dashed by `rings`: a dot has no dash of its own.
      if (offList)
        return dot(rows, {
          x: "x",
          y: "y",
          r: "r",
          key: "id",
          fill: SURFACE,
          stroke: SURFACE,
          strokeWidth: 0,
          renderer: canvasChartRenderer,
        })
      return dot(rows, {
        x: "x",
        y: "y",
        r: "r",
        key: "id",
        fill: outlined ? SURFACE : color,
        stroke: outlined ? color : SURFACE,
        strokeWidth: outlined ? 2 : 1,
        renderer: canvasChartRenderer,
      })
    })
  })

// The dots that print their code or type inside: those big enough for it.
const insideOf = (nodes: ReadonlyArray<NodeRow>) =>
  Effect.sync(() =>
    nodes.filter((node) => node.inside !== undefined && node.r >= INSIDE_FROM)
  )

// The nodes of `graph` that print their code or type inside at `view`.
export const printedInside = Effect.fnUntraced(function* (
  graph: Graph,
  layout: Layout,
  view: Viewport,
  showOffList: boolean
) {
  const { nodes } = yield* placed(graph, layout, view, showOffList)
  return yield* insideOf(nodes)
})

// An Off list holder's dashed ring: every other chord of a polygon round
// its dot, in layout units, so it zooms with the dot.
const RING_CHORDS = 24
const rings = (nodes: ReadonlyArray<NodeRow>, unit: number) =>
  Effect.sync(() =>
    nodes
      .filter(({ offList }) => offList)
      .flatMap((node) =>
        Array.from({ length: RING_CHORDS / 2 }, (_, index) => {
          const from = (4 * Math.PI * index) / RING_CHORDS
          const to = from + (2 * Math.PI) / RING_CHORDS
          return {
            id: `${node.id} ring ${index}`,
            x1: node.x + node.r * unit * Math.cos(from),
            y1: node.y + node.r * unit * Math.sin(from),
            x2: node.x + node.r * unit * Math.cos(to),
            y2: node.y + node.r * unit * Math.sin(to),
          }
        })
      )
  )

export const mapDefinition = Effect.fnUntraced(function* (options: {
  readonly graph: Graph
  readonly layout: Layout
  readonly view: Viewport
  readonly size: { readonly width: number; readonly height: number }
  readonly hovered: string | undefined
  // The node a search highlighted.
  readonly searched: string | undefined
  readonly showOffList: boolean
  readonly nodeOf: (datum: unknown) => MapNode | undefined
}) {
  const { graph, layout, view, size, hovered, searched, showOffList, nodeOf } =
    options
  const domains = yield* viewportDomains(view, size)
  const { nodes, links } = yield* placed(graph, layout, view, showOffList)
  const held = links.flatMap((each) =>
    each.move === undefined || each.move === "off list"
      ? []
      : [{ ...each, move: each.move }]
  )
  const left = links.filter(({ move }) => move === "off list")
  // A custodian link has no move.
  const through = links.filter(({ move }) => move === undefined)
  const inside = yield* insideOf(nodes)
  // Labelled: the focus and its neighbours, and the node hovered. A stock
  // whose code is printed inside needs no label beside it, but the node a
  // search picked is labelled whatever it prints, to be found.
  const labelled = nodes.filter(
    (node) =>
      node.id === searched ||
      ((node.labelled || node.id === hovered) &&
        !(node.label === node.inside && node.r >= INSIDE_FROM))
  )
  return defineChart({
    // Links and text are decorative: the dots alone take the pointer and
    // the arrow keys.
    marks: [
      decorative(
        link(left, {
          x1: "x1",
          y1: "y1",
          x2: "x2",
          y2: "y2",
          key: "id",
          stroke: MOVE_COLOR["off list"],
          strokeOpacity: OFF_LIST_OPACITY,
          strokeWidth: 1,
          strokeDasharray: OFF_LIST_DASH,
          renderer: canvasChartRenderer,
        })
      ),
      decorative(
        link(through, {
          x1: "x1",
          y1: "y1",
          x2: "x2",
          y2: "y2",
          key: "id",
          stroke: CUSTODIAN_COLOR,
          strokeOpacity: 0.45,
          strokeWidth: (row) => Math.max(0.5, row.strokeWidth),
          renderer: canvasChartRenderer,
        })
      ),
      decorative(
        link(held, {
          x1: "x1",
          y1: "y1",
          x2: "x2",
          y2: "y2",
          key: "id",
          stroke: (row) => MOVE_COLOR[row.move],
          strokeOpacity: (row) => (row.move === "unchanged" ? 0.55 : 0.85),
          strokeWidth: (row) => Math.max(0.5, row.strokeWidth),
          renderer: canvasChartRenderer,
        })
      ),
      ...(yield* dots(nodes)),
      decorative(
        link(yield* rings(nodes, view.unit), {
          x1: "x1",
          y1: "y1",
          x2: "x2",
          y2: "y2",
          key: "id",
          stroke: MOVE_COLOR["off list"],
          strokeOpacity: OFF_LIST_OPACITY + 0.2,
          strokeWidth: 1.5,
          renderer: canvasChartRenderer,
        })
      ),
      decorative(
        text(inside, {
          x: "x",
          y: "y",
          key: "id",
          text: (node) => node.inside,
          fill: (node) =>
            node.band === "1%" || node.offList
              ? node.color
              : "var(--bg-canvas)",
          fontSize: 10,
          fontWeight: 650,
          dy: 3.5,
        })
      ),
      decorative(
        text(labelled, {
          x: "x",
          y: "y",
          key: "id",
          text: "label",
          fill: "var(--text-primary)",
          fontSize: 11,
          fontWeight: 550,
          dy: (node) => node.r + 12,
        })
      ),
    ],
    scales: {
      x: { scale: scaleLinear().domain(domains.x), axis: false },
      // Layout y runs down, as the screen does.
      y: {
        scale: scaleLinear().domain(domains.y),
        axis: false,
        reverse: true,
      },
    },
    guides: false,
    margin: 0,
    keyboard: true,
    tooltip: {
      use: tooltip,
      portal,
      sticky: false,
      format: (point) => {
        const node = nodeOf(point.datum)
        return node === undefined ? "" : Effect.runSync(tooltipText(node))
      },
    },
  })
})
