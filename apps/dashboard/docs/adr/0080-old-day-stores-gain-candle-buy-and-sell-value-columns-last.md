# Old day stores gain candle buy and sell value columns last

A day store from before candles carried buy and sell value gains both columns last, as in `SCHEMA`, so the candles INSERT fits it. Today's candles and an unsealed day's get the values from the stored trades in that same transaction, since today's bubbles answer until midnight (`bubblesAnswer`). A sealed past day's candles keep 0, because Market Bubbles is live only.

Sites:
- `apps/dashboard/src/server/market-live/day-store.ts`

Source: apinrdw/kumora#436
