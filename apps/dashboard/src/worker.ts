// The dashboard Worker's entry (`main` in alchemy.run.ts): Market Live's
// sockets first, then TanStack Start. It also exports the Durable Object and
// Workflow classes the stack declares.
import startEntry from "@tanstack/react-start/server-entry"
import { Effect, Option } from "effect"

import { runKseiCron } from "./server/ksei/cron.ts"
import { KSEI_CRON } from "./server/ksei/schedule.ts"
import { marketLiveRoute } from "./server/market-live/entry.ts"
import { respond } from "./server/market-live/respond.ts"
import { runArchiveCron } from "./server/shareholding/cron.ts"

export { DayIndexObject as DayIndex } from "./server/market-live/day-index-object.ts"
export { TradingDayObject as TradingDay } from "./server/market-live/trading-day-object.ts"
export { KseiArchive } from "./server/ksei/workflow.ts"
export { ShareholdingArchive } from "./server/shareholding/workflow.ts"

export default {
  // Decision: Cloudflare calls `fetch` and wants a Promise, so it runs the
  // route through the runner. Picking the route is pure and synchronous.
  fetch: (request: Request) =>
    Option.match(Effect.runSync(marketLiveRoute(request)), {
      onNone: () => startEntry.fetch(request),
      onSome: respond,
    }),
  // The archive crons, on Production only (alchemy.run.ts). Each firing
  // names its expression: the KSEI archive's starts a KSEI archive run, the
  // other the shareholding archive's.
  scheduled: (controller: ScheduledController) =>
    controller.cron === KSEI_CRON
      ? runKseiCron(controller.scheduledTime)
      : runArchiveCron(controller.scheduledTime),
}
