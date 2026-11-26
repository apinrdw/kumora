# Cold views are stored for each listed, traded or booked code

When a day moves cold, its views are written for each code that was listed, traded or booked. A walk day has no code list, and every day replays with every view, so the list alone can't decide which codes get answers; any other code answers 404 once the day is cold. SweepBrokers is stored as found and cached for good, since a cold day takes no more broker codes.

Sites:

- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#556
