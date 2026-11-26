# Disclosure runs backfill the oldest incomplete days

The disclosure archive reaches back to IDX's first disclosure day, 3 July 2023 (~269k disclosures, ~600k files, ~130 GB), with no backfill action of its own. Each disclosure run lists the last 7 days first and stores what they wait for. What is left of its budget of FILES_PER_RUN (1,000) attachments goes to the oldest days that aren't complete, from the first day on: a day listed after it ended is taken up as the index holds it, any other is listed first, and the run takes up days until their waiting attachments fill the budget, at most 31 days a run. The `files:` steps store the recent days' attachments newest day first, then the older days' oldest first. A day more than 7 days old becomes complete when a run has listed it after it ended and none of its attachments waits; ArchiveDb records when (`disclosure_day.complete_at`, `archive-migrations/0006_disclosure_day_complete.sql`), and no run lists it again. A run whose days still wait when its budget is spent ends partial, as one with a failed download does, and the next run takes those attachments up first, before listing another day. At one run every 15 minutes, ~96,000 files a day, the history is stored in about a week.

A backfill action or a separate cursor was the alternative: the spec wants one kind of run, and the index already says which days are complete. Reporting a run out of budget as complete would hide that the archive is still behind; the coverage by day shows how far behind.

Sites:
- `apps/dashboard/src/server/disclosures/archive-run.ts`
- `apps/dashboard/src/server/disclosures/coverage.ts`

Source: apinrdw/kumora#715, apinrdw/kumora#718
