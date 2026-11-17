import { createServerFn } from "@tanstack/react-start"
import { runServerEffect } from "@workspace/server"
import { DateTime, Effect } from "effect"

import { liveDayAt } from "./closed-market.ts"
import { marketClockOffset, withMarketClock } from "./market-clock.ts"

// /market-bubbles' loader: the live day on Market Live's clock, when its
// date turns, and how far that clock runs ahead of the Worker's, so the
// page's windows end at the market's now (the Test stage shifts it).
export const marketBubblesFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(
    Effect.all({
      day: withMarketClock(Effect.flatMap(DateTime.now, liveDayAt)),
      clockOffset: marketClockOffset,
    }).pipe(Effect.map(({ day, clockOffset }) => ({ ...day, clockOffset })))
  )
)
