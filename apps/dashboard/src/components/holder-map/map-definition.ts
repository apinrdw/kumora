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

import { percentOf } from "@/components/stocks/holder-cells"
import { KSEI_TYPE_LABELS } from "@/domain/holdings"
import {
  type HolderMapView,
  type MapNode,
  ORIGIN_LABEL,
  type ShownMove,
} from "@/lib/holder-map"
import type { Layout } from "@/lib/holder-map-layout"
import { type Viewport, viewportDomains } from "@/lib/holder-map-viewport"

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
export const MOVE_COLOR: Record<ShownMove, string> = {
  new: "var(--semantic-info)",
  up: "var(--semantic-up)",
  down: "var(--semantic-down)",
  transfer: "var(--text-secondary)",
  unchanged: "var(--text-muted)",
  "up into 5%": "var(--semantic-up)",
  "down out of 5%": "var(--semantic-down)",
}
const SURFACE = "var(--bg-surface)"

// A node placed, its radius in px and its colour.
type NodeRow = MapNode & { x: number; y: number; r: number; color: string }

const tooltipText = Effect.fnUntraced(function* (
  node: MapNode,
  focusCode: string
) {
  if (node.kind === "stock")
    return node.focus ? `${node.name} · focus stock` : node.name
  const lines = [node.name]
  if (node.stakeHundredths !== undefined)
    lines.push(`${yield* percentOf(node.stakeHundredths)} of ${focusCode}`)
  lines.push(
    [
      node.origin === undefined ? "Origin unknown" : ORIGIN_LABEL[node.origin],
      node.investorType === undefined
        ? "Type unknown"
        : KSEI_TYPE_LABELS[node.investorType],
    ].join(" · ")
  )
  return lines.join("\n")
})

const placed = (graph: Graph, layout: Layout, view: Viewport) =>
  Effect.sync(() => {
    const nodes = graph.nodes.flatMap((node): Array<NodeRow> => {
      const at = layout.positions[node.id]
      if (at === undefined) return []
      const color =
        node.kind === "stock"
          ? STOCK_COLOR
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

// One dot mark per colour and band: a dot's fill and stroke are fixed per
// mark. The 5% band is filled and the 1% band outlined.
const dots = (nodes: ReadonlyArray<NodeRow>) =>
  Effect.sync(() => {
    const groups = new Map<string, Array<NodeRow>>()
    for (const node of nodes) {
      const key = `${node.band === "1%" ? "outlined" : "filled"} ${node.color}`
      groups.set(key, [...(groups.get(key) ?? []), node])
    }
    return [...groups.values()].map((rows) => {
      const outlined = rows[0]?.band === "1%"
      const color = rows[0]?.color ?? STOCK_COLOR
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
  readonly code: string
  readonly nodeOf: (datum: unknown) => MapNode | undefined
}) {
  const { graph, layout, view, size, hovered, code, nodeOf } = options
  const domains = yield* viewportDomains(view, size)
  const { nodes, links } = yield* placed(graph, layout, view)
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
        link(links, {
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
