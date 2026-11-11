// The dashboard Worker's entry (`main` in alchemy.run.ts): Market Live's
// sockets first, then TanStack Start. It also exports the Durable Object
// classes the stack declares.
import startEntry from "@tanstack/react-start/server-entry"
import { marketLiveRoute } from "./server/market-live/entry.ts"
import { respond } from "./server/market-live/respond.ts"

export { DayIndexObject as DayIndex } from "./server/market-live/day-index-object.ts"
export { TradingDayObject as TradingDay } from "./server/market-live/trading-day-object.ts"

export default {
  fetch: (request: Request) => {
    const route = marketLiveRoute(request)
    return route === undefined ? startEntry.fetch(request) : respond(route)
  },
}
