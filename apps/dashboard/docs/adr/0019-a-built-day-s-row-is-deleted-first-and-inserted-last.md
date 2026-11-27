# A built day's row is deleted first and inserted last

A broker totals build writes a day in a fixed order: its built-days row is deleted, its totals and candles are deleted and inserted in batches, and its built-days row is inserted last. A half-written or rebuilding day reads as a gap, and a repeated build converges, because every write starts by deleting the day.

Sites:

- `apps/dashboard/src/server/broker-totals/db.ts`

Source: apinrdw/kumora#419
