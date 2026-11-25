// The dashboard Worker's entry (`main` in alchemy.run.ts): the redirect into
// the dashboard base path first, then Market Live's sockets, then TanStack
// Start. It also exports the Durable Object and
// Workflow classes the stack declares.
import startEntry from "@tanstack/react-start/server-entry"
import { Effect, Option } from "effect"

import { redirectIntoBase } from "./server/base-redirect.ts"
import { runCron } from "./server/crons.ts"
import { marketLiveRoute } from "./server/market-live/entry.ts"
import { respond } from "./server/market-live/respond.ts"

export { DayIndexObject as DayIndex } from "./server/market-live/day-index-object.ts"
export { TradingDayObject as TradingDay } from "./server/market-live/trading-day-object.ts"
export { KseiArchive } from "./server/ksei/workflow.ts"
export { KseiParse } from "./server/ksei/parse-workflow.ts"
export {
  Above1Parse,
  Above5Parse,
  ClassificationParse,
  InvestorTypeParse,
} from "./server/shareholding/parse-workflow.ts"
export { ShareholdingArchive } from "./server/shareholding/workflow.ts"

export default {
  // Cloudflare calls `fetch` and wants a Promise, so it runs the
  // route through the runner. Picking the route is pure and synchronous.
  fetch: (request: Request) =>
    Option.match(Effect.runSync(redirectIntoBase(request)), {
      onSome: (redirect) => redirect,
      onNone: () =>
        Option.match(Effect.runSync(marketLiveRoute(request)), {
          onNone: () => startEntry.fetch(request),
          onSome: respond,
        }),
    }),
  scheduled: (controller: ScheduledController) =>
    runCron(controller.cron, controller.scheduledTime),
}
