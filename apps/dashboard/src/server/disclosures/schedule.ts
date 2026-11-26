// The disclosure cron and when it next starts a run, for ../stage-crons.ts
// and the admin page. Free of server imports, so the page's components can
// word the schedule from it.
import { Effect } from "effect"

// The disclosure cron (UTC): every 15 minutes, so a disclosure reaches the
// archive within about 15 minutes of IDX posting it. A firing while a run is
// in progress is skipped (runs.ts). stageCrons sets it on Production only,
// and runCron (../crons.ts) tells it apart by this expression, which no
// other cron shares.
// Decision: the owner accepted IDX terms-of-use exposure for its crons
// (apps/dashboard/docs/adr/0009-the-owner-accepted-idx-s-terms-of-use-exposure.md)
export const DISCLOSURE_CRON = "*/15 * * * *"

const QUARTER_HOUR = 15 * 60 * 1000

// The first quarter hour after `now`.
export const nextDisclosureRun = Effect.fnUntraced(function* (now: Date) {
  return new Date((Math.floor(now.getTime() / QUARTER_HOUR) + 1) * QUARTER_HOUR)
})
