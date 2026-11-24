# ArchiveDb is the source of truth for runs

Each archive's runs lived in its R2 bucket as one JSON record per run and a latest pointer, so the admin pages listed and read R2 across an ocean for every load (apinrdw/kumora#659). Every run of either archive is now a row in ArchiveDb's `run` table (`archive-migrations/0002_runs.sql`), keyed by archive, run kind and id, with the columns its reads filter and sort on and the whole record as JSON. A run's steps rewrite only its row, and a read decodes the record with today's run schemas, so an old record still decodes as ADR 0052 keeps it. A record can be as large as a run's summary step returns, 1 MiB, so a read of many runs cuts each record to the fields it shows in ArchiveDb (`json_object` over `->`, which keeps each field's JSON type) and never reads whole records of more than a few runs: 30 days of hourly runs would otherwise hold 720 MiB, past a Worker's 128. The R2 records and pointers are frozen: nothing writes them again. Each run kind imports them once, the first time it is read or claimed on a stage, and `run_import` marks it imported so no later read touches R2. The import copies the run the pointer names, the runs of the past 30 days, and the newest run each reader older than that still finds. The e2e seeds (`apps/e2e/support/runs.ts`) write rows and mark the kind imported, as a stage past the cutover is. Undoing this means writing runs back to R2, since a stage past its import has rows R2 never saw.

Sites:
- `apps/dashboard/src/server/archive/run-rows.ts`
- `apps/dashboard/src/server/archive/run-import.ts`

Source: apinrdw/kumora#659
