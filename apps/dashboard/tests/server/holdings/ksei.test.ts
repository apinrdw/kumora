import { Worker } from "node:worker_threads"

import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { MAX_ENTRY_BYTES } from "@/server/holdings/zip"

import { zipOf } from "./zip-of.ts"

// Decision: parsing a KSEI report takes at most 48 MiB of heap, so the
// Worker's 128 MiB still holds the archived file and the run around it.
const PARSE_HEAP_MIB = 48

const TYPES = ["IS", "CP", "PF", "IB", "ID", "MF", "SC", "FD", "OT"]

const HEADER = [
  "Date|Code|Type|Sec. Num|Price",
  ...TYPES.map((type) => `Local ${type}`),
  "Total",
  ...TYPES.map((type) => `Foreign ${type}`),
  "Total",
].join("|")

// A zip of the largest file KSEI's zip entry may inflate to: the header,
// then as many of `line`'s lines as fit.
const largestFile = (line: (number: number) => string) => {
  const lines = [HEADER]
  let size = HEADER.length
  for (
    let number = 2;
    size + 1 + line(number).length <= MAX_ENTRY_BYTES;
    number++
  ) {
    lines.push(line(number))
    size += 1 + line(number).length
  }
  return zipOf([
    ["Balancepos20261030.txt", new TextEncoder().encode(lines.join("\n"))],
  ])
}

// What parsing `bytes` fails with, parsed in a worker thread whose heap
// stops at PARSE_HEAP_MIB.
const parseInBoundedHeap = (bytes: Uint8Array) =>
  Effect.callback<string, Error>((resume) => {
    const worker = new Worker(
      new URL("./parse-ksei-worker.ts", import.meta.url),
      {
        workerData: bytes,
        resourceLimits: { maxOldGenerationSizeMb: PARSE_HEAP_MIB },
      }
    )
    worker.once("message", (message: string) => resume(Effect.succeed(message)))
    worker.once("error", (error) => resume(Effect.fail(error)))
    return Effect.promise(() => worker.terminate())
  })

describe(`the largest Securities holdings report, parsed in ${PARSE_HEAP_MIB} MiB of heap`, () => {
  it.effect(
    "is refused at its first line of two-letter lines",
    () =>
      Effect.gen(function* () {
        const bytes = yield* largestFile(() => "ab")
        assert.strictEqual(
          yield* parseInBoundedHeap(bytes),
          "Line 2 has 1 fields"
        )
      }),
    { timeout: 30_000 }
  )

  it.effect(
    "is refused once it lists more stocks than a month can",
    () =>
      Effect.gen(function* () {
        // Each stock holds a share of every type.
        const bytes = yield* largestFile(
          (number) =>
            `30-Oct-2026|S${number}|EQUITY|1|1|${"1|".repeat(9)}9|${"1|".repeat(9)}9`
        )
        assert.strictEqual(
          yield* parseInBoundedHeap(bytes),
          "The report lists more than 2,000 stocks"
        )
      }),
    { timeout: 30_000 }
  )
})
