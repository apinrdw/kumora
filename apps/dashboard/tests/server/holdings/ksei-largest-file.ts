// A Node worker thread that parses the largest KSEI file of one shape and
// posts the parse's failure message. It imports by relative path because
// it runs in plain Node, outside Vitest's aliases.
import { parentPort, workerData } from "node:worker_threads"

import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import { parseKseiMonth } from "../../../src/server/holdings/ksei.ts"
import { MAX_ENTRY_BYTES } from "../../../src/server/holdings/zip.ts"
import { zipOf } from "./zip-of.ts"

const TYPES = ["IS", "CP", "PF", "IB", "ID", "MF", "SC", "FD", "OT"]

const HEADER = [
  "Date|Code|Type|Sec. Num|Price",
  ...TYPES.map((type) => `Local ${type}`),
  "Total",
  ...TYPES.map((type) => `Foreign ${type}`),
  "Total",
].join("|")

// A line `line` of the file's shape: a two-letter line, or a stock that
// holds a share of every type.
const lineOf = (shape: string, line: number) =>
  shape === "short lines"
    ? "ab"
    : `30-Oct-2026|S${line}|EQUITY|1|1|${"1|".repeat(9)}9|${"1|".repeat(9)}9`

// As many lines of the shape as fit the largest entry a zip inflates to.
const largestFile = (shape: string) => {
  const lines = [HEADER]
  let size = HEADER.length
  for (
    let line = 2;
    size + 1 + lineOf(shape, line).length <= MAX_ENTRY_BYTES;
    line++
  ) {
    lines.push(lineOf(shape, line))
    size += 1 + lineOf(shape, line).length
  }
  return new TextEncoder().encode(lines.join("\n"))
}

Effect.runFork(
  Effect.gen(function* () {
    const bytes = yield* zipOf([
      ["Balancepos20261030.txt", largestFile(String(workerData))],
    ])
    const error = yield* Effect.flip(
      parseKseiMonth("2026-10-30", "sha", bytes, "2026-11-15T00:00:00Z")
    )
    parentPort?.postMessage(error.message)
  }).pipe(
    Effect.provideService(HoldingsDb, {
      batch: () => Effect.die("A refused file is never written"),
    })
  )
)
