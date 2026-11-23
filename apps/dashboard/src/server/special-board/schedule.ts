// The Special Monitoring Board cron. Free of server imports, so
// ../stage-crons.ts can read it.

// The board cron (UTC): 23:00 WIB every day, an hour after the sector cron
// (22:00), so their IDX reads never overlap. IDX's list runs a trading day
// behind, so the evening read picks up the day's changes. stageCrons sets it
// on Production only, and runCron (../crons.ts) tells it apart by this
// expression.
// Decision: the owner accepted IDX terms-of-use exposure for its crons
// (apps/dashboard/docs/adr/0009-the-owner-accepted-idx-s-terms-of-use-exposure.md)
export const SPECIAL_BOARD_CRON = "0 16 * * *"
