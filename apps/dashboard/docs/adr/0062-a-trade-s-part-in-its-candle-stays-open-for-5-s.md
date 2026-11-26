# A trade's part in its candle stays open for 5 s

A trade can arrive from more than one feed. Its part in its candle stays open for 5 s after it first arrived, so a second feed's copy can still move or reprice it; after that a later feed changes only the tape row. A minute that such a copy emptied goes out as a footprint with no cells and no candle (`takeChanged`). `apps/e2e/support/clock.ts` repeats the 5 s.

Sites:

- `apps/dashboard/src/server/market-live/candles.ts`

Source: apinrdw/kumora#138
