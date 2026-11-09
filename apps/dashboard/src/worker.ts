// The dashboard Worker's entry (`main` in alchemy.run.ts): Market Live's
// sockets first, then TanStack Start. It also exports the Durable Object
// classes the stack declares.
import startEntry from "@tanstack/react-start/server-entry"
import { runServerEffectResult } from "@workspace/server"
import { Result } from "effect"

import { marketLiveRoute } from "./server/market-live/entry.ts"

export { DayIndexObject as DayIndex } from "./server/market-live/day-index-object.ts"
export { TradingDayObject as TradingDay } from "./server/market-live/trading-day-object.ts"

export default {
  fetch: (request: Request) => {
    const route = marketLiveRoute(request)
    if (route === undefined) return startEntry.fetch(request)
    // The routes fail with no HTTP error, so a failure is the runner's bare
    // 500, already logged.
    return runServerEffectResult(route).then((settled) =>
      Result.isSuccess(settled)
        ? settled.success
        : settled.failure instanceof Response
          ? settled.failure
          : new Response(null, { status: 500 })
    )
  },
}
