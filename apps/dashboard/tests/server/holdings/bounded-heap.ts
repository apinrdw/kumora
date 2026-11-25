import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import { Effect } from "effect"
import { build } from "vite"

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
// at `mib`. Work past it fails with the worker's out-of-memory error. The
// young generation is fixed: V8 sizes it from the heap limit otherwise, so
// on Node 26 a derive passed at 72 MiB, failed at 80 and passed at 96.
export const inBoundedHeap = (worker: URL, data: unknown, mib: number) =>
  Effect.callback<string, Error>((resume) => {
    const thread = new Worker(worker, {
      workerData: data,
      resourceLimits: {
        maxOldGenerationSizeMb: mib,
        maxYoungGenerationSizeMb: 16,
      },
    })
    thread.once("message", (message: string) => resume(Effect.succeed(message)))
    thread.once("error", (error) => resume(Effect.fail(error)))
    return Effect.promise(() => thread.terminate())
  })

// The worker `entry` and all it imports as one module, a `data:` URL that
// inBoundedHeap runs: a worker that renders components, which plain Node
// can't load (JSX, `@/`). React's production build is in it, the one a
// Worker runs.
export const bundled = (entry: URL) =>
  Effect.promise(() =>
    build({
      configFile: false,
      logLevel: "silent",
      root: fileURLToPath(new URL("../../../", import.meta.url)),
      resolve: { tsconfigPaths: true },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      // Vitest's NODE_ENV would pick React's development JSX.
      oxc: { jsx: { runtime: "automatic", development: false } },
      ssr: { noExternal: true },
      build: {
        ssr: fileURLToPath(entry),
        write: false,
        minify: false,
        rolldownOptions: {
          // The bridge imports it when a request runs, which none does here.
          external: ["cloudflare:workers"],
          output: { codeSplitting: false },
        },
      },
    })
  ).pipe(
    Effect.map((built) => {
      const [{ output }] = [built].flat() as Array<{
        output: ReadonlyArray<{ type: string; code?: string }>
      }>
      const code = output.find(({ type }) => type === "chunk")?.code ?? ""
      return new URL(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
      )
    })
  )

// What parsing `bytes` as `report` posts (parse-worker.ts), parsed in a
// worker thread whose heap stops at PARSE_HEAP_MIB.
export const parseInBoundedHeap = (report: Report, bytes: Uint8Array) =>
  inBoundedHeap(
    new URL("./parse-worker.ts", import.meta.url),
    { report, bytes },
    PARSE_HEAP_MIB
  )
