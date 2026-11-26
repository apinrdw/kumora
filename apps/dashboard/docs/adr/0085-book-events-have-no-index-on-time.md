# Book events have no index on time

`book_events` has no index on `time`. Reading the newest events visits and sorts every book event of the day, 2 rows read an event, but an object does it once, at its first snapshot (`book-event-log.ts`). An index read 100 rows for 100 events, but it wrote 2 rows an event, and a row written costs 1,000 read (`docs/runbooks/order-flow-cost.md`), so it pays only past 500 such reads a day.

Sites:

- `apps/dashboard/src/server/market-live/day-store.ts`

Source: apinrdw/kumora#588
