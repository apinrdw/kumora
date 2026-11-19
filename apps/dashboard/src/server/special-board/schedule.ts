// The Special Monitoring Board cron. Free of server imports, so
// ../stage-crons.ts can read it.

// The board cron (UTC): 23:00 WIB every day, an hour after the sector cron
// (22:00), so their IDX reads never overlap. IDX's list runs a trading day
// behind, so the evening read picks up the day's changes. stageCrons sets it
// on Production only, and runCron (../crons.ts) tells it apart by this
// expression.
// Decision: IDX's terms of use forbid reading its site by automated means
// without its consent; the owner accepted that exposure for the sector cron
// (apinrdw/kumora#410, #416, #427), and this cron reads the same site the
// same way, once a day. See spec apinrdw/kumora#517.
export const SPECIAL_BOARD_CRON = "0 16 * * *"
