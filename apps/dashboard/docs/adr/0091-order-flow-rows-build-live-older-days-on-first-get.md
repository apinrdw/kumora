# Order flow rows build live, older days on first GET

A day that has stored nothing yet writes its order flow rows live, so it is marked built from the start. Any other day without the mark was recorded, whole or in part, before order flow shipped; once sealed, its first order flow GET builds the rows.

Sites:
- `apps/dashboard/src/server/market-live/order-flow-build.ts`

Source: apinrdw/kumora#263
