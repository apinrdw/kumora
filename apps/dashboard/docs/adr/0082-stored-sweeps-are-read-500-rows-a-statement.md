# Stored sweeps are read 500 rows a statement

`eachStoredSweeps` reads stored sweeps 500 rows a statement, paging by the table's key. `Sql.exec` hands back a statement's rows whole, and the worst day's sweeps in one statement held 75 MiB against the spec's ~30 MB. Paged, the read peaks at 12 MiB (`sweep-alerts-memory.test.ts`).

Sites:

- `apps/dashboard/src/server/market-live/day-store.ts`

Source: apinrdw/kumora#510
