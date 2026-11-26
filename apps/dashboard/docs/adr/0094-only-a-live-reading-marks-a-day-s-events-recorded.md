# Only a live reading marks a day's events recorded

Book events and order flow events came after many days were already recorded. A day is marked as holding them only by a live reading: a ledger read from live books marks book events, and an object that judged minutes marks order flow events. A History walk or a seal alone marks neither. A day without the mark answers none, marked not recorded, so its page says so rather than "none yet".

Sites:

- `apps/dashboard/src/server/market-live/recorded-answers.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#517, apinrdw/kumora#605
