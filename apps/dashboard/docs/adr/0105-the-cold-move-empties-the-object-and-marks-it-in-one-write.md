# The cold move empties the object and marks it in one write

When a day moves to the cold store, its object must never be found half-emptied. `deleteAll()` and the cold mark's put go out with no await between them, so the output gate writes them as one: a restart finds either the day whole or the mark. The alarm goes first, so nothing wakes the emptied object.

Sites:
- `apps/dashboard/src/server/market-live/trading-day-object.ts`

Source: apinrdw/kumora#556
