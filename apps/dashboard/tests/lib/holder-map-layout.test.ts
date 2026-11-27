import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  fitExtent,
  holderMapLayout,
  type LayoutGraph,
} from "@/lib/holder-map-layout"

const graph = (holders: number): LayoutGraph => ({
  nodes: [
    { id: "stock:TRUE", radius: 22, focus: true },
    ...Array.from({ length: holders }, (_, index) => ({
      id: `holder:${index}`,
      radius: 5 + index,
      focus: false,
    })),
  ],
  links: Array.from({ length: holders }, (_, index) => ({
    source: "stock:TRUE",
    target: `holder:${index}`,
  })),
})

describe("holderMapLayout", () => {
  it.effect("places every node, the focus at the centre", () =>
    Effect.gen(function* () {
      const layout = yield* holderMapLayout(graph(6))
      expect(Object.keys(layout.positions).sort()).toEqual(
        [
          "holder:0",
          "holder:1",
          "holder:2",
          "holder:3",
          "holder:4",
          "holder:5",
          "stock:TRUE",
        ].sort()
      )
      expect(layout.positions["stock:TRUE"]).toEqual({ x: 0, y: 0 })
    })
  )

  it.effect("gives the same picture for the same graph", () =>
    Effect.gen(function* () {
      const first = yield* holderMapLayout(graph(40))
      const second = yield* holderMapLayout(graph(40))
      expect(second).toEqual(first)
    })
  )

  it.effect("lays out a focus with no holders", () =>
    Effect.gen(function* () {
      const layout = yield* holderMapLayout(graph(0))
      expect(layout.positions).toEqual({ "stock:TRUE": { x: 0, y: 0 } })
      const extent = yield* fitExtent(layout, graph(0).nodes)
      expect(extent.x[0]).toBeLessThan(extent.x[1])
      expect(extent.y[0]).toBeLessThan(extent.y[1])
    })
  )
})

describe("fitExtent", () => {
  it.effect("bounds every node shown", () =>
    Effect.gen(function* () {
      const all = graph(12)
      const layout = yield* holderMapLayout(all)
      const extent = yield* fitExtent(layout, all.nodes)
      for (const { x, y } of Object.values(layout.positions)) {
        expect(x).toBeGreaterThanOrEqual(extent.x[0])
        expect(x).toBeLessThanOrEqual(extent.x[1])
        expect(y).toBeGreaterThanOrEqual(extent.y[0])
        expect(y).toBeLessThanOrEqual(extent.y[1])
      }
    })
  )

  it.effect(
    "fits the nodes shown only, as with the Off list hidden, on the same layout",
    () =>
      Effect.gen(function* () {
        const all = graph(12)
        const layout = yield* holderMapLayout(all)
        const shown = all.nodes.slice(0, 3)
        const bound = (
          pick: (at: { x: number; y: number }, r: number) => number
        ) =>
          shown.map(({ id, radius }) => {
            const at = layout.positions[id] ?? { x: NaN, y: NaN }
            return pick(at, radius)
          })
        expect(yield* fitExtent(layout, shown)).toEqual({
          x: [
            Math.min(...bound(({ x }, r) => x - r)) - 40,
            Math.max(...bound(({ x }, r) => x + r)) + 40,
          ],
          y: [
            Math.min(...bound(({ y }, r) => y - r)) - 40,
            Math.max(...bound(({ y }, r) => y + r)) + 40,
          ],
        })
      })
  )
})
