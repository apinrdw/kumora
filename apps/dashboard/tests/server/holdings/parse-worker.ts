// A Node worker thread that parses the report it is given, KSEI's or one of
// IDX's, and posts the number of stocks parsed or the parse's
// failure message. It runs in plain Node, outside Vitest's aliases, so it
// resolves `@/` to src/ itself.
import { registerHooks } from "node:module"
import { parentPort, workerData } from "node:worker_threads"

import { Effect } from "effect"

import { HoldingsDb } from "../../../src/server/holdings/db.ts"
import type { Report } from "./bounded-heap.ts"

const SRC = new URL("../../../src/", import.meta.url)

registerHooks({
  resolve: (specifier, context, next) =>
    next(
      specifier.startsWith("@/")
        ? new URL(`${specifier.slice(2)}.ts`, SRC).href
        : specifier,
      context
    ),
})

const { report, bytes } = workerData as {
  readonly report: Report
  readonly bytes: Uint8Array
}

type Parse = (
  date: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) => Effect.Effect<number, { readonly message: string }, HoldingsDb>

const parse: Parse =
  report === "ksei"
    ? (await import("../../../src/server/holdings/ksei.ts")).parseKseiMonth
    : report === "classification"
      ? (await import("../../../src/server/holdings/classification.ts"))
          .parseClassificationMonth
      : (await import("../../../src/server/holdings/investor-type.ts"))
          .parseInvestorTypeMonth

Effect.runFork(
  parse("2026-10-30", "sha", bytes, "2026-11-15T00:00:00Z").pipe(
    Effect.match({
      onSuccess: (stocks) => `Parsed ${stocks} stocks`,
      onFailure: (error) => error.message,
    }),
    Effect.tap((message) =>
      Effect.sync(() => parentPort?.postMessage(message))
    ),
    Effect.provideService(HoldingsDb, { batch: () => Effect.succeed([]) })
  )
)
