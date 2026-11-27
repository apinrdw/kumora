# Market Bubbles values are stored once at the move

A day's Market Bubbles values are stored once, when the day moves cold. The next trading day's object asks for them only the morning after, by when the day is usually cold. They are built as the hot answer is, from one pass over the day's candles (`storedBubbles`): about 400 K rows read on a full day, once, on top of the busy day's 385 K.

Sites:

- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#517
