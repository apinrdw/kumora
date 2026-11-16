import { createServerFn } from "@tanstack/react-start"
import { runServerEffect } from "@workspace/server"
import { Effect } from "effect"

import { marketClockOffset, marketToday } from "./market-clock.ts"

// /market-bubbles' loader: the live day on Market Live's clock, and how far
// that clock runs ahead of the Worker's, so the page's windows end at the
// market's now (the Test stage shifts it).
export const marketBubblesFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(
    Effect.all({ today: marketToday, clockOffset: marketClockOffset })
  )
)
