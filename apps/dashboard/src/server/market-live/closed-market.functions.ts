import { createServerFn } from "@tanstack/react-start"
import { runServerEffect } from "@workspace/server"
import { DateTime, Effect } from "effect"

import { closedMarketAt } from "./closed-market.ts"
import { marketClockOffset, withMarketClock } from "./market-clock.ts"

// /market-live's loader: whether the market is shut, on Market Live's clock,
// and how far that clock runs ahead of the Worker's, so the bubble panel's
// windows end at the market's now (the Test stage shifts it).
export const closedMarketFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(
    Effect.all({
      market: withMarketClock(Effect.flatMap(DateTime.now, closedMarketAt)),
      clockOffset: marketClockOffset,
    }).pipe(
      Effect.map(({ market, clockOffset }) => ({ ...market, clockOffset }))
    )
  )
)
