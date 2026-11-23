// The crons a stage's Worker runs, for alchemy.run.ts. Free of server
// imports, as the schedules it reads are; runCron (./crons.ts) tells them
// apart by expression.
import { RECONCILE_CRON } from "./broker-totals/schedule.ts"
import { KSEI_CRON, KSEI_PARSE_CRON } from "./ksei/schedule.ts"
import { LOGO_CRON } from "./logos/schedule.ts"
import { SECTOR_CRON } from "./sectors/schedule.ts"
import { ARCHIVE_CRON, PARSE_CRON } from "./shareholding/schedule.ts"
import { SPECIAL_BOARD_CRON } from "./special-board/schedule.ts"

export const stageCrons = (production: boolean) => [
  // Decision: crons that call outside sources run on Production only
  // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
  RECONCILE_CRON,
  // Decision: crons that call outside sources run on Production only
  // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
  ...(production
    ? [
        ARCHIVE_CRON,
        // Decision: crons that call outside sources run on Production only
        // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
        KSEI_CRON,
        // Decision: crons that call outside sources run on Production only
        // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
        KSEI_PARSE_CRON,
        // Decision: crons that call outside sources run on Production only
        // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
        PARSE_CRON,
        // Decision: crons that call outside sources run on Production only
        // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
        SECTOR_CRON,
        // Decision: crons that call outside sources run on Production only
        // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
        LOGO_CRON,
        // Decision: crons that call outside sources run on Production only
        // (apps/dashboard/docs/adr/0007-crons-that-read-outside-sources-run-on-production-only.md)
        SPECIAL_BOARD_CRON,
      ]
    : []),
]
