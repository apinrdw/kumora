// The archive cron and when it next starts a run, for alchemy.run.ts and the
// admin page. Free of server imports, so the page's components can word the
// schedule from it.
import { Effect } from "effect"

import { nextRunOf, timesWib } from "../archive/schedule.ts"

// The archive cron (UTC). alchemy.run.ts sets it on Production only.
export const ARCHIVE_CRON = "0 6,13 * * *"

// "13:00 and 20:00 WIB"
export const ARCHIVE_TIMES_WIB = Effect.runSync(timesWib(ARCHIVE_CRON))

export const nextScheduledRun = (now: Date) => nextRunOf(ARCHIVE_CRON, now)
