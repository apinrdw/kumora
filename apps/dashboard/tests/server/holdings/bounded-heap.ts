import { Worker } from "node:worker_threads"

import { Effect } from "effect"

// Decision: a report's parse is bounded to fit 48 MiB of the Worker's heap
// (apps/dashboard/docs/adr/0045-a-holdings-parse-fits-a-bounded-heap.md)
export const PARSE_HEAP_MIB = 48

export type Report =
  | "ksei"
  | "classification"
  | "investor-type"
  | "above-1"
  | "above-5"

// What the worker thread `worker` posts when handed `data`, its heap stopped
// at `mib`. Work past it fails with the worker's out-of-memory error.
export const inBoundedHeap = (worker: URL, data: unknown, mib: number) =>
  Effect.callback<string, Error>((resume) => {
    const thread = new Worker(worker, {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: mib },
    })
    thread.once("message", (message: string) => resume(Effect.succeed(message)))
    thread.once("error", (error) => resume(Effect.fail(error)))
    return Effect.promise(() => thread.terminate())
  })

// What parsing `bytes` as `report` posts (parse-worker.ts), parsed in a
// worker thread whose heap stops at PARSE_HEAP_MIB.
export const parseInBoundedHeap = (report: Report, bytes: Uint8Array) =>
  inBoundedHeap(
    new URL("./parse-worker.ts", import.meta.url),
    { report, bytes },
    PARSE_HEAP_MIB
  )
