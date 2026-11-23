# An emptied object answers cold days from R2

Once a day is cold, its emptied Durable Object answers from R2 itself. A Worker isolate can still count the day hot for up to a minute (`COLD_DAYS_KEPT_MS` in `days.ts`) and route a request to the object; answering from R2 there gives it the same answers, so the move can empty the object as soon as the day index marks it cold. The object reads `bucket` for each answer from the request it answers.

Sites:
- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#556
