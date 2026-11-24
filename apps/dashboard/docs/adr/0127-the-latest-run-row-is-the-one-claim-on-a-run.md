# The latest run row is the one claim on a run

ArchiveDb holds every run (apinrdw/kumora#659), so the R2 run pointer and its conditional put (ADR 0044) no longer claim a start. A cron firing and Run now, Parse now or Deep backfill can still start a run of one kind at once. Each kind's run rows carry a `latest` flag, and a unique partial index allows one row per archive and run kind with it set (`run_claim` in `archive-migrations/0002_runs.sql`). A start judges the row that holds the flag against its Workflow instance's status, as before. When that run has ended, one batch hands the flag on and inserts the new run's row holding it. The insert is the claim: of two starts that judged the same holder, the index lets one insert, and the other judges again and finds the winner in progress. The holder is the kind's last run, so the last run card reads that same row.

Sites:
- `apps/dashboard/src/server/archive/runs.ts`

Source: apinrdw/kumora#662
