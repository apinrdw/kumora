# Day store tables are keyed WITHOUT ROWID

The day store's tables, other than the trades, are keyed `WITHOUT ROWID` and replaced at most once a minute; the trades are the tape's (`tape-chunks.ts`). The sweep brokers table is keyed by (code, minute) like the footprint rows: its answer reads one code's rows, and a recompute replaces each touched minute's rows by key without scanning the table. Its `sweeps` column stays declared TEXT, as every day's table was made, and SQLite keeps a row's gzipped BLOB as it is.

Sites:
- `apps/dashboard/src/server/market-live/day-store.ts`
- `apps/dashboard/src/server/market-live/sweep-brokers.ts`

Source: apinrdw/kumora#138
