// The sector cron. Free of server imports, so ../stage-crons.ts and the
// admin page's Sectors card can read it.
import { Effect } from "effect"

import { timesWib } from "../archive/schedule.ts"

// The sector cron (UTC): 22:00 WIB every day, after the evening archive run
// (20:00) and the parse cron (21:00), so a run never overlaps their IDX
// reads. stageCrons sets it on Production only, and runCron
// (../crons.ts) tells it from the archive crons by this expression.
// Decision: the owner accepted IDX terms-of-use exposure for its crons
// (apps/dashboard/docs/adr/0009-the-owner-accepted-idx-s-terms-of-use-exposure.md)
export const SECTOR_CRON = "0 15 * * *"

// "22:00 WIB"
export const SECTOR_TIME_WIB = Effect.runSync(timesWib(SECTOR_CRON))
