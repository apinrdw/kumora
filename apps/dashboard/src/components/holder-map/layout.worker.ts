// Lays out the Holder map off the main thread (spec apinrdw/kumora#733,
// "Rendering"): a hub focus can draw thousands of nodes, and the force
// layout's ticks would freeze the page. It lays out one graph at a time;
// the page terminates it to drop a graph it has replaced.
import { Effect } from "effect"

import { holderMapLayout, type LayoutGraph } from "@/lib/holder-map-layout"

export interface LayoutRequest {
  readonly graph: LayoutGraph
}

self.addEventListener("message", (event: MessageEvent<LayoutRequest>) => {
  self.postMessage({
    layout: Effect.runSync(holderMapLayout(event.data.graph)),
  })
})
