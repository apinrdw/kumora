// The Holder map's layout, run in a web worker (layout.worker.ts) so a hub
// focus never blocks the page.
import { Effect } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"

import type { HolderMapView } from "@/lib/holder-map"
import { type Layout, layoutInputOf } from "@/lib/holder-map-layout"

import type { LayoutRequest } from "./layout.worker"

type Graph = NonNullable<HolderMapView["focus"]>["graph"]

// The graph's layout, keyed on its nodes and links (`layoutInputOf`):
// undefined until the worker answers for that key. A new graph that would
// lay out the same, as a reload or revalidation gives, keeps the layout it
// has; one that gained or lost a node or link is laid out again.
export function useHolderMapLayout(graph: Graph): Layout | undefined {
  const worker = useRef<Worker | undefined>(undefined)
  // The newest request's id and key: an answer to an older one is dropped.
  const asked = useRef<{ id: number; key: string | undefined }>({
    id: 0,
    key: undefined,
  })
  const [answer, setAnswer] = useState<{ key: string; layout: Layout }>()
  const { input, key } = useMemo(
    () => Effect.runSync(layoutInputOf(graph)),
    [graph]
  )
  useEffect(() => {
    const current = new Worker(new URL("./layout.worker.ts", import.meta.url), {
      type: "module",
    })
    const onMessage = (event: MessageEvent<{ id: number; layout: Layout }>) => {
      const { id, key: askedKey } = asked.current
      if (event.data.id === id && askedKey !== undefined)
        setAnswer({ key: askedKey, layout: event.data.layout })
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
    if (current === undefined || asked.current.key === key) return
    const id = asked.current.id + 1
    asked.current = { id, key }
    const request: LayoutRequest = { id, graph: input }
    current.postMessage(request)
  }, [input, key])
  return answer?.key === key ? answer.layout : undefined
}
