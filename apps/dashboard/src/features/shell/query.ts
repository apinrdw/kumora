import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"

import { runtime } from "@/lib/runtime"
import { Market } from "@/services/market"

const shellPage = Effect.fn("shellQuery")(function* () {
  const market = yield* Market
  return yield* market.overview
})

/** The shell's query: the root loader's only call into the runtime. */
export const shellQuery = createServerFn().handler(() =>
  runtime.runPromise(shellPage())
)
