// A Node worker thread that parses the KSEI zip it is given and posts the
// parse's failure message. It imports by relative path because it runs in
// plain Node, outside Vitest's aliases.
import { parentPort, workerData } from "node:worker_threads"

import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import { parseKseiMonth } from "../../../src/server/holdings/ksei.ts"

Effect.runFork(
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      parseKseiMonth(
        "2026-10-30",
        "sha",
        workerData as Uint8Array,
        "2026-11-15T00:00:00Z"
      )
    )
    parentPort?.postMessage(error.message)
  }).pipe(
    Effect.provideService(HoldingsDb, {
      batch: () => Effect.die("A refused file is never written"),
    })
  )
)
