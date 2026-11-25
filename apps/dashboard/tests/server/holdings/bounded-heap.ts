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

// What parsing `bytes` as `report` posts (parse-worker.ts), parsed in a
// worker thread whose heap stops at PARSE_HEAP_MIB. A parse past it fails
// with the worker's out-of-memory error.
export const parseInBoundedHeap = (report: Report, bytes: Uint8Array) =>
  Effect.callback<string, Error>((resume) => {
    const worker = new Worker(new URL("./parse-worker.ts", import.meta.url), {
      workerData: { report, bytes },
      resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MIB },
    })
    worker.once("message", (message: string) => resume(Effect.succeed(message)))
    worker.once("error", (error) => resume(Effect.fail(error)))
    return Effect.promise(() => worker.terminate())
  })
