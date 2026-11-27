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
import {
  type HolderMapView,
  type LinkMove,
  type MapNode,
  MOVE_LABEL,
  type NodeMove,
  ORIGIN_LABEL,
} from "@/lib/holder-map"
import type { Layout } from "@/lib/holder-map-layout"
import { type Viewport, viewportDomains } from "@/lib/holder-map-viewport"
import { dayDateLabel, monthLabel } from "@/lib/stock-page-display"

type Graph = NonNullable<HolderMapView["focus"]>["graph"]

// A dot prints its code or type inside only from this radius in px.
const INSIDE_FROM = 10

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

export const tooltipText = Effect.fnUntraced(function* (
  node: MapNode,
  focusCode: string
) {
  if (node.kind === "stock")
    return node.focus ? `${node.name} · focus stock` : node.name
  const lines = [node.name]
  if (node.stakeHundredths !== undefined)
    lines.push(
      `${yield* percentOf(node.stakeHundredths)} of ${focusCode}${node.offList ? " last" : ""}`
    )
  if (node.move !== undefined && node.move.kind === "off list") {
    lines.push(yield* moveText(node.move))
    return lines.join("\n")
  }
  lines.push(
    [
      node.origin === undefined ? "Origin unknown" : ORIGIN_LABEL[node.origin],
      node.investorType === undefined
        ? "Type unknown"
        : KSEI_TYPE_LABELS[node.investorType],
    ].join(" · ")
  )
  if (node.move !== undefined) lines.push(yield* moveText(node.move))
  return lines.join("\n")
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
      const color =
        node.kind === "stock"
          ? STOCK_COLOR
          : node.offList
            ? MOVE_COLOR["off list"]
            : ORIGIN_COLOR[node.origin ?? "unknown"]
      return [{ ...node, ...at, r: node.radius / view.unit, color }]
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
      groups.set(key, [...(groups.get(key) ?? []), node])
    }
    return [...groups.values()].map((rows) => {
      const offList = rows[0]?.offList === true
      const outlined = offList || rows[0]?.band === "1%"
      const color = rows[0]?.color ?? STOCK_COLOR
      if (offList)
        return dot(rows, {
          x: "x",
          y: "y",
          r: "r",
          key: "id",
          fill: SURFACE,
          stroke: color,
          strokeWidth: 1.5,
          strokeOpacity: OFF_LIST_OPACITY,
          // A dot's dash is a state style only: one that always holds.
          states: [
            { when: () => true, style: { strokeDasharray: OFF_LIST_DASH } },
          ],
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

export const mapDefinition = Effect.fnUntraced(function* (options: {
  readonly graph: Graph
  readonly layout: Layout
  readonly view: Viewport
  readonly size: { readonly width: number; readonly height: number }
  readonly hovered: string | undefined
  readonly showOffList: boolean
  readonly code: string
  readonly nodeOf: (datum: unknown) => MapNode | undefined
}) {
  const { graph, layout, view, size, hovered, showOffList, code, nodeOf } =
    options
  const domains = yield* viewportDomains(view, size)
  const { nodes, links } = yield* placed(graph, layout, view, showOffList)
  const held = links.filter(({ move }) => move !== "off list")
  const left = links.filter(({ move }) => move === "off list")
  const inside = nodes.filter(
    (node) => node.inside !== undefined && node.r >= INSIDE_FROM
  )
  // Labelled: the focus and its neighbours, and the node hovered. A stock
  // whose code is printed inside needs no label beside it.
  const labelled = nodes.filter(
    (node) =>
      (node.labelled || node.id === hovered) &&
      !(node.label === node.inside && node.r >= INSIDE_FROM)
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
        text(inside, {
          x: "x",
          y: "y",
          key: "id",
          text: (node) => node.inside,
          fill: (node) =>
            node.band === "1%" ? node.color : "var(--bg-canvas)",
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
        return node === undefined ? "" : Effect.runSync(tooltipText(node, code))
      },
    },
  })
})
