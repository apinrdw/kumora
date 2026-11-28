---
Status: superseded by ADR-0142
---

# Disclosure runs backfill the oldest incomplete days

The disclosure archive reaches back to IDX's first disclosure day, 3 July 2023 (~269k disclosures, ~600k files, ~130 GB), with no backfill action of its own. Each disclosure run lists the recent days first, the last RECENT_DAYS (`disclosure-day.ts`), and stores what they wait for. What is left of its budget of FILES_PER_RUN attachments (`archive-run.ts`) goes to the oldest days that aren't complete, from the first day on: a day listed after it ended is taken up as the index holds it, any other is listed first, and the run takes up days until their waiting attachments fill the budget, at most MAX_BACKFILL_DAYS a run. The `files:` steps store the recent days' attachments newest day first, then the older days' oldest first. A day older than the recent days becomes complete when a run has listed it after it ended and none of its attachments waits; ArchiveDb records when (`disclosure_day.complete_at`, `archive-migrations/0006_disclosure_day_complete.sql`), and no run lists it again. A run whose days still wait when its budget is spent ends partial, as one with a failed download does, and the next run takes those attachments up first, before listing another day. Only a recent day's listing that can't be read fails a run. An older day's is left as it was: the run names the day and IDX's answer on its record (`unlistedDays`), takes up the day after it, stores the recent days' attachments and ends partial, and the next run lists that day again. Failing the run there would leave the recent days unstored for as long as IDX can't serve that day, since every run takes the oldest incomplete day first. At one run every 15 minutes, 96 budgets a day, the history is stored in about a week.

A backfill action or a separate cursor was the alternative: the spec wants one kind of run, and the index already says which days are complete. Reporting a run out of budget as complete would hide that the archive is still behind; the coverage by day shows how far behind.

Sites:

- `apps/dashboard/src/server/disclosures/archive-run.ts`
- `apps/dashboard/src/server/disclosures/disclosure-day.ts`
- `apps/dashboard/src/server/disclosures/run-result.ts`

Source: apinrdw/kumora#715, apinrdw/kumora#718
