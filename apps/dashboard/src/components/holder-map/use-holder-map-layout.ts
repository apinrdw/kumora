// The Holder map's layout, run in a web worker (layout.worker.ts) so a hub
// focus never blocks the page.
import { useEffect, useRef, useState } from "react"

import type { HolderMapView } from "@/lib/holder-map"
import type { Layout } from "@/lib/holder-map-layout"

import type { LayoutRequest } from "./layout.worker"

type Graph = NonNullable<HolderMapView["focus"]>["graph"]

// The graph's layout, keyed on its focus and day: undefined until the worker
// answers for that key. A new graph of the same focus and day, as a reload
// or revalidation gives, keeps the layout it has.
export function useHolderMapLayout(graph: Graph): Layout | undefined {
  const worker = useRef<Worker | undefined>(undefined)
  // The newest request's id and key: an answer to an older one is dropped.
  const asked = useRef<{ id: number; key: string | undefined }>({
    id: 0,
    key: undefined,
  })
  const [answer, setAnswer] = useState<{ key: string; layout: Layout }>()
  useEffect(() => {
    const current = new Worker(new URL("./layout.worker.ts", import.meta.url), {
      type: "module",
    })
    const onMessage = (event: MessageEvent<{ id: number; layout: Layout }>) => {
      const { id, key } = asked.current
      if (event.data.id === id && key !== undefined)
        setAnswer({ key, layout: event.data.layout })
    }
    current.addEventListener("message", onMessage)
    worker.current = current
    return () => {
      current.removeEventListener("message", onMessage)
      current.terminate()
      worker.current = undefined
      asked.current = { id: asked.current.id, key: undefined }
    }
  }, [])
  useEffect(() => {
    const current = worker.current
    if (current === undefined || asked.current.key === graph.key) return
    const id = asked.current.id + 1
    asked.current = { id, key: graph.key }
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
  }, [graph])
  return answer?.key === graph.key ? answer.layout : undefined
}
