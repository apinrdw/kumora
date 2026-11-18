import { createServerFn } from "@tanstack/react-start"
import { runServerEffect } from "@workspace/server"
import { DateTime, Effect } from "effect"

import { closedMarketAt } from "./closed-market.ts"
import { withMarketClock } from "./market-clock.ts"

// /market-live's loader: whether the market is shut, on Market Live's clock.
export const closedMarketFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(withMarketClock(Effect.flatMap(DateTime.now, closedMarketAt)))
)
