// The disclosure cron and when it next starts a run, for ../stage-crons.ts
// and the admin page. Free of server imports, so the page's components can
// word the schedule from it.
import { Effect } from "effect"

const EVERY_MINUTES = 15

// The disclosure cron (UTC): every 15 minutes, so a disclosure reaches the
// archive within about 15 minutes of IDX posting it. A firing while a run is
// in progress is skipped (runs.ts). stageCrons sets it on Production only,
// and runCron (../crons.ts) tells it apart by this expression, which no
// other cron shares.
// Decision: the owner accepted IDX terms-of-use exposure for its crons
// (apps/dashboard/docs/adr/0009-the-owner-accepted-idx-s-terms-of-use-exposure.md)
export const DISCLOSURE_CRON = `*/${EVERY_MINUTES} * * * *`

// How the admin page words when the cron fires.
export const DISCLOSURE_EVERY = `every ${EVERY_MINUTES} minutes`

const EVERY_MS = EVERY_MINUTES * 60 * 1000

// The cron's first firing after `now`.
export const nextDisclosureRun = Effect.fnUntraced(function* (now: Date) {
  return new Date((Math.floor(now.getTime() / EVERY_MS) + 1) * EVERY_MS)
})
