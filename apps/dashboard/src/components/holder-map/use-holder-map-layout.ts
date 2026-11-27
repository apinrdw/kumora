// The Holder map's layout, run in a web worker (layout.worker.ts) so a hub
// focus never blocks the page.
import { Effect } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"

import type { HolderMapView } from "@/lib/holder-map"
import { type Layout, layoutInputOf } from "@/lib/holder-map-layout"

import type { LayoutRequest } from "./layout.worker"

type Graph = NonNullable<HolderMapView["focus"]>["graph"]

// The worker last asked for a layout, the key it was asked for, and
// whether it is still at it.
interface Job {
  readonly worker: Worker
  readonly key: string
  readonly busy: boolean
}

// The graph's layout, keyed on its nodes and links (`layoutInputOf`):
// undefined until the worker answers for that key. A new graph that would
// lay out the same, as a reload or revalidation gives, keeps the layout it
// has; one that gained or lost a node or link is laid out again.
export function useHolderMapLayout(graph: Graph): Layout | undefined {
  const job = useRef<Job | undefined>(undefined)
  const [answer, setAnswer] = useState<{ key: string; layout: Layout }>()
  const { input, key } = useMemo(
    () => Effect.runSync(layoutInputOf(graph)),
    [graph]
  )
  useEffect(
    () => () => {
      job.current?.worker.terminate()
      job.current = undefined
    },
    []
  )
  useEffect(() => {
    const last = job.current
    if (last?.key === key) return
    // The force layout runs to its end once started, so a graph still
    // laying out is stopped with its worker, and the new one laid out
    // without waiting behind it.
    if (last?.busy) last.worker.terminate()
    const worker =
      last && !last.busy ? last.worker : startWorker(job, setAnswer)
    job.current = { worker, key, busy: true }
    const request: LayoutRequest = { graph: input }
    worker.postMessage(request)
  }, [input, key])
  return answer?.key === key ? answer.layout : undefined
}

// A worker whose answers set the layout of the job it is at.
function startWorker(
  job: { current: Job | undefined },
  setAnswer: (answer: { key: string; layout: Layout }) => void
) {
  const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), {
    type: "module",
  })
  worker.addEventListener(
    "message",
    (event: MessageEvent<{ layout: Layout }>) => {
      const current = job.current
      if (current?.worker !== worker || !current.busy) return
      job.current = { ...current, busy: false }
      setAnswer({ key: current.key, layout: event.data.layout })
    }
  )
  return worker
}
