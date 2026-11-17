// The crons a stage's Worker runs, for alchemy.run.ts. Free of server
// imports, as the schedules it reads are; runCron (./crons.ts) tells them
// apart by expression.
import { RECONCILE_CRON } from "./broker-totals/schedule.ts"
import { KSEI_CRON, KSEI_PARSE_CRON } from "./ksei/schedule.ts"
import { LOGO_CRON } from "./logos/schedule.ts"
import { SECTOR_CRON } from "./sectors/schedule.ts"
import { ARCHIVE_CRON, PARSE_CRON } from "./shareholding/schedule.ts"

export const stageCrons = (production: boolean) => [
  // Decision: the broker totals reconcile runs on every stage: each stage
  // builds into its own BrokerTotalsDb, and the extension's extra target
  // feeds a second stage. It touches only the stage's own day index, D1 and
  // trading days, so a dev or Preview run calls nothing outside. See spec
  // apinrdw/kumora#437, "Dashboard: reconcile cron".
  RECONCILE_CRON,
  // Decision: the archive cron is set by stage, on Production only, like
  // Google sign-in: Alchemy's dev runtime fires a Worker's crons, so an
  // ungated cron would make `pnpm dev`, and every Preview, call IDX. Other
  // stages start a run with Run now only. See apinrdw/kumora#308.
  ...(production
    ? [
        ARCHIVE_CRON,
        // Decision: the KSEI archive cron is gated the same way, so only
        // Production calls ksei.co.id on a schedule. See apinrdw/kumora#326.
        KSEI_CRON,
        // Decision: the KSEI parse cron too, so only Production's
        // HoldingsDb fills on a schedule, from the only bucket that holds
        // reports. See apinrdw/kumora#359.
        KSEI_PARSE_CRON,
        // Decision: the shareholding parse cron too, for the KSEI parse
        // cron's reason. See apinrdw/kumora#397.
        PARSE_CRON,
        // Decision: the sector cron too, so only Production reads IDX's
        // company profiles on a schedule; any other stage's stock_sector
        // stays empty. See apinrdw/kumora#427.
        SECTOR_CRON,
        // Decision: the logo sync too, so only Production copies
        // Stockbit's logos. See apinrdw/kumora#432.
        LOGO_CRON,
      ]
    : []),
]
