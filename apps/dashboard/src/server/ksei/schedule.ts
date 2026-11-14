// The KSEI archive cron and when it next starts a run, for alchemy.run.ts
// and the admin page. Free of server imports, so the page's components can
// word the schedule from it.
import { Effect } from "effect"

import { nextRunOf, timesWib } from "../archive/schedule.ts"

// The KSEI archive cron (UTC): 10:00 WIB every day. alchemy.run.ts sets it
// on Production only, and src/worker.ts tells it from the shareholding
// archive's cron by this expression.
// Decision: daily, after KSEI's uploads at about 07:08 WIB on the first
// weekday after a period end, so a new month's files are archived the
// morning they appear. See apinrdw/kumora#322.
export const KSEI_CRON = "0 3 * * *"

// "10:00 WIB"
export const KSEI_TIMES_WIB = Effect.runSync(timesWib(KSEI_CRON))

export const nextKseiRun = (now: Date) => nextRunOf(KSEI_CRON, now)
