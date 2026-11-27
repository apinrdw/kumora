import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { holderMapLayout, type LayoutGraph } from "@/lib/holder-map-layout"

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

  it.effect("bounds every node inside its extent", () =>
    Effect.gen(function* () {
      const layout = yield* holderMapLayout(graph(12))
      for (const { x, y } of Object.values(layout.positions)) {
        expect(x).toBeGreaterThanOrEqual(layout.extent.x[0])
        expect(x).toBeLessThanOrEqual(layout.extent.x[1])
        expect(y).toBeGreaterThanOrEqual(layout.extent.y[0])
        expect(y).toBeLessThanOrEqual(layout.extent.y[1])
      }
    })
  )

  it.effect("lays out a focus with no holders", () =>
    Effect.gen(function* () {
      const layout = yield* holderMapLayout(graph(0))
      expect(layout.positions).toEqual({ "stock:TRUE": { x: 0, y: 0 } })
      expect(layout.extent.x[0]).toBeLessThan(layout.extent.x[1])
      expect(layout.extent.y[0]).toBeLessThan(layout.extent.y[1])
    })
  )
})
