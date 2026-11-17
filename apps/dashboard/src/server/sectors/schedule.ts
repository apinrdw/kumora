// The sector cron. Free of server imports, so ../stage-crons.ts can read it.

// The sector cron (UTC): 22:00 WIB every day, after the evening archive run
// (20:00) and the parse cron (21:00), so a run never overlaps their IDX
// reads. stageCrons sets it on Production only, and runCron
// (../crons.ts) tells it from the archive crons by this expression.
// Decision: IDX's terms of use forbid reading its site by automated means
// without its consent; the owner accepted that exposure for this cron on
// 2026-11-16, the same as the shareholding archive's. See apinrdw/kumora#427.
export const SECTOR_CRON = "0 15 * * *"
