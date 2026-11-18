// The archive cron and the parse cron, and when each next starts a run, for
// alchemy.run.ts and the admin page. Free of server imports, so the page's
// components can word the schedule from it.
import { Effect } from "effect"

import { nextRunOf, timesWib } from "../archive/schedule.ts"

// The archive cron (UTC). alchemy.run.ts sets it on Production only.
export const ARCHIVE_CRON = "0 6,13 * * *"

// "13:00 and 20:00 WIB"
export const ARCHIVE_TIMES_WIB = Effect.runSync(timesWib(ARCHIVE_CRON))

export const nextScheduledRun = (now: Date) => nextRunOf(ARCHIVE_CRON, now)

// The parse cron (UTC): 21:00 WIB every day, an hour after the evening
// archive run, so a report archived that evening is parsed the same evening.
// Each firing starts a classification parse run, an investor-type parse run
// and an above-1% parse run (parse-runs.ts). alchemy.run.ts sets it on Production only, and runCron
// (../crons.ts) tells it from the archive crons by this expression.
// Decision: parse runs of their own, not steps of the archive run: they read
// only R2 and HoldingsDb, so a parse failure no longer makes an archive run
// partial, and parsing needs no IDX listing. See apinrdw/kumora#397.
export const PARSE_CRON = "0 14 * * *"

// "21:00 WIB"
export const PARSE_TIMES_WIB = Effect.runSync(timesWib(PARSE_CRON))

export const nextParseRun = (now: Date) => nextRunOf(PARSE_CRON, now)
