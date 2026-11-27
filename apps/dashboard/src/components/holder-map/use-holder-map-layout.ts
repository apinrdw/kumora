// The Holder map's layout, run in a web worker (layout.worker.ts) so a hub
// focus never blocks the page.
import { useEffect, useRef, useState } from "react"

import type { HolderMapView } from "@/lib/holder-map"
import type { Layout } from "@/lib/holder-map-layout"

import type { LayoutRequest } from "./layout.worker"

type Graph = NonNullable<HolderMapView["focus"]>["graph"]

// The graph's layout: undefined until the worker answers for this graph.
export function useHolderMapLayout(graph: Graph): Layout | undefined {
  const worker = useRef<Worker | undefined>(undefined)
  const asked = useRef(0)
  const [answer, setAnswer] = useState<{ graph: Graph; layout: Layout }>()
  useEffect(() => {
    const current = new Worker(new URL("./layout.worker.ts", import.meta.url), {
      type: "module",
    })
    worker.current = current
    return () => {
      current.terminate()
      worker.current = undefined
    }
  }, [])
  useEffect(() => {
    const current = worker.current
    if (current === undefined) return
    const id = ++asked.current
    const onMessage = (event: MessageEvent<{ id: number; layout: Layout }>) => {
      if (event.data.id === id) setAnswer({ graph, layout: event.data.layout })
    }
    current.addEventListener("message", onMessage)
    const request: LayoutRequest = {
      id,
      graph: {
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          radius: node.radius,
          focus: node.focus,
        })),
        links: graph.links.map(({ source, target }) => ({ source, target })),
      },
    }
    current.postMessage(request)
    return () => current.removeEventListener("message", onMessage)
  }, [graph])
  return answer?.graph === graph ? answer.layout : undefined
}
