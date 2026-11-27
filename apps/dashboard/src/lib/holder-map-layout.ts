// The Holder map's layout (spec apinrdw/kumora#733, "Rendering"): a static
// force layout of the graph, run in a web worker
// (components/holder-map/layout.worker.ts) so a hub focus never blocks the
// page. It is deterministic: the focus is pinned at the centre and every
// other node starts at a seeded place on a ring, in the graph's order, so a
// reload of one focus and day gives the same picture.
import { forceLayout } from "@tanstack/charts/network/force"
import { Effect } from "effect"

// What the layout needs of a node and a link.
export interface LayoutGraph {
  readonly nodes: ReadonlyArray<{
    readonly id: string
    readonly radius: number
    readonly focus: boolean
  }>
  readonly links: ReadonlyArray<{
    readonly source: string
    readonly target: string
  }>
}

export interface Layout {
  readonly positions: Readonly<Record<string, { x: number; y: number }>>
  // Every node's dot, plus a margin for its label: what fit-to-view shows.
  readonly extent: {
    readonly x: readonly [number, number]
    readonly y: readonly [number, number]
  }
}

// The seeded ring's radius, the gap a link keeps between its dots, the
// nodes' push apart, and the room kept round a dot.
const SEED_RING = 120
const LINK_GAP = 60
const REPULSION = -140
const COLLIDE_GAP = 4
// Room beyond the outermost dots for their labels, in layout units.
const MARGIN = 40
const ITERATIONS = 300

export const holderMapLayout = (graph: LayoutGraph) =>
  Effect.sync((): Layout => {
    const others = graph.nodes.filter(({ focus }) => !focus).length
    let ring = 0
    const seeded = graph.nodes.map((node) => {
      if (node.focus) return { ...node, x: 0, y: 0, fx: 0, fy: 0 }
      const angle = (2 * Math.PI * ring++) / Math.max(1, others)
      return {
        ...node,
        x: SEED_RING * Math.cos(angle),
        y: SEED_RING * Math.sin(angle),
      }
    })
    const radii = new Map(graph.nodes.map((node) => [node.id, node.radius]))
    const result = forceLayout(seeded, graph.links, {
      nodeKey: "id",
      source: "source",
      target: "target",
      iterations: ITERATIONS,
      forces: [
        {
          type: "link",
          distance: (link) =>
            (radii.get(link.source) ?? 0) +
            (radii.get(link.target) ?? 0) +
            LINK_GAP,
        },
        { type: "manyBody", strength: REPULSION },
        {
          type: "collide",
          radius: (node) => node.radius + COLLIDE_GAP,
          strength: 0.9,
        },
      ],
    })
    const positions: Record<string, { x: number; y: number }> = {}
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const node of result.nodes) {
      positions[node.id] = { x: node.x, y: node.y }
      x0 = Math.min(x0, node.x - node.radius)
      x1 = Math.max(x1, node.x + node.radius)
      y0 = Math.min(y0, node.y - node.radius)
      y1 = Math.max(y1, node.y + node.radius)
    }
    if (result.nodes.length === 0) {
      x0 = y0 = 0
      x1 = y1 = 0
    }
    return {
      positions,
      extent: {
        x: [x0 - MARGIN, x1 + MARGIN],
        y: [y0 - MARGIN, y1 + MARGIN],
      },
    }
  })
