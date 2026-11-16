// The broker totals reconcile cron, for ../stage-crons.ts. Free of server
// imports, as the archives' schedules are.

// The reconcile cron (UTC): 18:00 WIB every day, an hour after the seal, so
// the day just sealed is listed. stageCrons sets it on every stage, and
// runCron (../crons.ts) tells it from the archive crons by this expression.
export const RECONCILE_CRON = "0 11 * * *"
