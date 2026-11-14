// The dashboard Worker's entry (`main` in alchemy.run.ts): Market Live's
// sockets first, then TanStack Start. It also exports the Durable Object and
// Workflow classes the stack declares.
import startEntry from "@tanstack/react-start/server-entry"
import { Effect, Option } from "effect"

import { marketLiveRoute } from "./server/market-live/entry.ts"
import { respond } from "./server/market-live/respond.ts"
import { runArchiveCron } from "./server/shareholding/cron.ts"

export { DayIndexObject as DayIndex } from "./server/market-live/day-index-object.ts"
export { TradingDayObject as TradingDay } from "./server/market-live/trading-day-object.ts"
export { ShareholdingArchive } from "./server/shareholding/workflow.ts"

export default {
  // Decision: Cloudflare calls `fetch` and wants a Promise, so it runs the
  // route through the runner. Picking the route is pure and synchronous.
  fetch: (request: Request) =>
    Option.match(Effect.runSync(marketLiveRoute(request)), {
      onNone: () => startEntry.fetch(request),
      onSome: respond,
    }),
  // The archive cron, on Production only (alchemy.run.ts).
  scheduled: (controller: ScheduledController) =>
    runArchiveCron(controller.scheduledTime),
}
