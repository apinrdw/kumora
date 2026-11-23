# Today's object keeps the previous day's values as a fact

Today's trading-day object asks the previous trading day's object for its Market Bubbles values once a day, on the relay's token, and keeps them as a day store fact. A 404 (a day the relay didn't seal, after a gap) keeps none, so the floor reads today's value alone. A failed ask keeps nothing and asks again on the next token.

Sites:
- `apps/dashboard/src/server/market-live/previous-values.ts`

Source: apinrdw/kumora#517
