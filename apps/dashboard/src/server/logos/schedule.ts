// The logo cron (UTC): Sunday 03:00 WIB, once a week. stageCrons sets it
// on Production only, and runCron (../crons.ts) tells it from the other
// crons by this expression. Free of server imports, for ../stage-crons.ts.
// Weekly, at a quiet hour: logos change only on renames and new
// listings, a few dozen a year, and Stockbit adds a listing's logo weeks
// before it lists (docs/research/idx-company-logos.md).
export const LOGO_CRON = "0 20 * * 6"
