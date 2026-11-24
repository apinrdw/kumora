# The report index is a copy of R2 that each archive run heals

The admin pages read the archives' totals and coverage from a report index in ArchiveDb (ADR 0124) instead of listing `reports/` across an ocean. R2 stays the source of truth for reports: an index row is derived from its record's key and the sizes of the record and its file, so the index can be rebuilt from a listing at any time. A run inserts a report's row right after writing its record, in the same step, with insert-or-ignore keyed on the record key, so a retried step adds no second row. A crash between the two writes, or a bucket filled before ArchiveDb existed, leaves records unindexed, so each archive run starts by inserting every record its listing of `reports/` holds and the index lacks. That fills ArchiveDb on each stage with no one-off script. A record whose file isn't listed gets no row, since a run writes the file first. The rows live in `archive-migrations/0001_report_index.sql`.

Sites:
- `apps/dashboard/src/server/archive/report-index.ts`
- `apps/dashboard/src/server/ksei/archive-run.ts`
- `apps/dashboard/src/server/shareholding/archive-run.ts`

Source: apinrdw/kumora#659
