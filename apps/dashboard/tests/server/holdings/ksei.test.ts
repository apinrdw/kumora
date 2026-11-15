import { Worker } from "node:worker_threads"

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

// Decision: parsing a KSEI file takes at most 48 MiB of heap, so the
// Worker's 128 MiB still holds the archived file and the run around it.
const PARSE_HEAP_MIB = 48

// What parsing the largest file of `shape` fails with, parsed in a worker
// thread whose heap stops at PARSE_HEAP_MIB.
const parseInBoundedHeap = (shape: string) =>
  Effect.callback<string, Error>((resume) => {
    const worker = new Worker(
      new URL("./ksei-largest-file.ts", import.meta.url),
      {
        workerData: shape,
        resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MIB },
      }
    )
    worker.once("message", (message: string) => resume(Effect.succeed(message)))
    worker.once("error", (error) => resume(Effect.fail(error)))
    return Effect.promise(() => worker.terminate())
  })

describe(`the largest KSEI file, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  it.effect(
    "is refused at its first line of short lines",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* parseInBoundedHeap("short lines"),
          "Line 2 has 1 fields"
        )
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "is refused once it lists more stocks than a month can",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          yield* parseInBoundedHeap("stocks"),
          "The file lists more than 5,000 EQUITY stocks"
        )
      }),
    { timeout: 30_000 }
  )
})
