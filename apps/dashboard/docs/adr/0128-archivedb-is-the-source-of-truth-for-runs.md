# ArchiveDb is the source of truth for runs

Each archive's runs lived in its R2 bucket as one JSON record per run and a latest pointer, so the admin pages listed and read R2 across an ocean for every load (apinrdw/kumora#659). Every run of either archive is now a row in ArchiveDb's `run` table (`archive-migrations/0002_runs.sql`), keyed by archive, run kind and id, with the columns its reads filter and sort on and the whole record as JSON. A run's steps rewrite only its row, and a read decodes the record with today's run schemas, so an old record still decodes as ADR 0052 keeps it. A record can be as large as a run's summary step returns, 1 MiB, so a read of many runs cuts each record to the fields it shows in ArchiveDb (`json_object` over `->`, which keeps each field's JSON type) and never reads whole records of more than a few runs: 30 days of hourly runs would otherwise hold 720 MiB, past a Worker's 128. The e2e seeds (`apps/e2e/support/runs.ts`) write rows and mark the kind imported, as a stage past the cutover is. Undoing this means writing runs back to R2, since a stage past its import has rows R2 never saw.

The R2 records and pointers are frozen: nothing writes them again. Each run kind imports them once, from the first time it is read or claimed on a stage, and `run_import` marks it imported so no later read touches R2. A Worker invocation may make 1,000 D1 queries, a batch each, and 10,000 subrequests, every D1 and R2 call. One invocation's import of a kind therefore reads and writes at most `IMPORT_BATCHES` batches of `RECORDS_AT_ONCE` records (`run-import.ts`), whatever R2 holds, and an import with more to read stops there for the next invocation to resume. Until the import finishes, a page read or a start fails with `RunsImporting`: an admin page answers a Conflict that says the runs are still being copied, a start claims nothing, and a cron firing skips its run. A kind's R2 holds a few runs a day, so its import finishes on its first load.

The import is scans of the kind's R2 records, each with one purpose:

- a window scan for each trigger, for its runs of the past 30 days;
- the latest scan, for the run the latest pointer names, which the last run card shows and which holds the claim (ADR 0127);
- a reader scan for each trigger with a reader past retention, for the newest run that reader takes, however old.

The first import kept one mark per record for every purpose (`archive-migrations/0003_run_import_progress.sql`). A record that one purpose passed over was then never read for another, so a latest run that started in the cutoff's hour, just before the 30 days, was lost. Each scan now keeps where it stopped in a row of its own (`archive-migrations/0004_run_import_scans.sql`, which drops the tables of `0003`). The import keeps the rules below. Each has a test in `tests/server/archive/last-run.test.ts` or `tests/server/admin/ksei.test.ts`.

1. A window scan keeps every run it reads. It lists a trigger's records from the key of a run started 30 days before, and keeps each one that decodes under its own key, whatever start the record gives. Only a read of the past 30 days filters by start.
2. The latest scan keeps the pointer's run however old, whatever another scan made of its record. That run holds the claim when the import finishes.
3. A reader scan keeps the newest run its reader takes, wherever that run lies relative to the 30 days, and however many invocations the import takes.
4. A scan reads and writes only its own progress. Scans share only a run's row, which every scan wants, so no scan's pass over a record hides it from another.
5. A scan's progress only moves on. An invocation resumes each scan where the furthest one stopped, and a scan reads no record twice.
6. One invocation stays within its limits at any number of R2 records, and holds at most `RECORDS_AT_ONCE` records at once.
7. An import that failed part-way, or that raced another, ends in the same rows. An import that has finished never reads R2 or adds a row again.

Sites:
- `apps/dashboard/src/server/archive/run-rows.ts`
- `apps/dashboard/src/server/archive/run-import.ts`
- `apps/dashboard/src/server/archive/runs.ts`

Source: apinrdw/kumora#659
