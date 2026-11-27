// Lays out the Holder map off the main thread (spec apinrdw/kumora#733,
// "Rendering"): a hub focus can draw thousands of nodes, and the force
// layout's ticks would freeze the page.
import { Effect } from "effect"

import { holderMapLayout, type LayoutGraph } from "@/lib/holder-map-layout"

export interface LayoutRequest {
  // Echoed back, so the page drops an answer to a graph it has replaced.
  readonly id: number
  readonly graph: LayoutGraph
}

self.addEventListener("message", (event: MessageEvent<LayoutRequest>) => {
  const { id, graph } = event.data
  self.postMessage({ id, layout: Effect.runSync(holderMapLayout(graph)) })
})
