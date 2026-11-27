# Cold days live in a table of their own

The day index records cold days in a table of their own, not as a field of the seal's row. A retried seal replaces that row, and a separate table keeps the cold flag through it; the days table also needs no new column.

Sites:

- `apps/dashboard/src/server/market-live/day-index.ts`

Source: apinrdw/kumora#556
