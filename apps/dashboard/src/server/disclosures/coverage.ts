// How far the disclosure archive reaches: each disclosure day from IDX's
// first to today in WIB, complete, incomplete or not yet listed (spec
// apinrdw/kumora#715, ticket #718).

// IDX's first disclosure day, YYYY-MM-DD in WIB: GetAnnouncement listed
// nothing before 3 July 2023 when probed on 2026-11-26. The oldest day a run
// backfills (archive-run.ts) and the first the coverage shows.
// Decision: each disclosure run backfills the oldest incomplete days with its leftover budget
// (apps/dashboard/docs/adr/0138-disclosure-runs-backfill-the-oldest-incomplete-days.md)
export const FIRST_DISCLOSURE_DAY = "2023-07-03"
