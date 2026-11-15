// A Node worker thread that parses the report it is given, KSEI's or IDX's
// classification one, and posts the number of stocks parsed or the parse's
// failure message. It runs in plain Node, outside Vitest's aliases, so it
// resolves `@/` to src/ itself.
import { registerHooks } from "node:module"
import { parentPort, workerData } from "node:worker_threads"

import { Effect } from "effect"

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
  readonly report: "ksei" | "classification"
  readonly bytes: Uint8Array
}

const { HoldingsDb } = await import("../../../src/server/holdings/db.ts")
const parse =
  report === "ksei"
    ? (await import("../../../src/server/holdings/ksei.ts")).parseKseiMonth
    : (await import("../../../src/server/holdings/classification.ts"))
        .parseClassificationMonth

Effect.runFork(
  parse("2026-10-30", "sha", bytes, "2026-11-15T00:00:00Z").pipe(
    Effect.match({
      onSuccess: (stocks) => `Parsed ${stocks} stocks`,
      onFailure: (error) => error.message,
    }),
    Effect.tap((message) => parentPort?.postMessage(message)),
    Effect.provideService(HoldingsDb, { batch: () => Effect.succeed([]) })
  )
)
