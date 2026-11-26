# The reconcile poke builds a sealed day at once

The reconcile cron pokes only days the broker totals DB holds unbuilt or older, and a DB reset can leave a day this version already built. So the poke builds a sealed, buildable day on the alarm at once, marked due, whatever the day's own fact says. Other days it leaves alone.

Sites:

- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#437
