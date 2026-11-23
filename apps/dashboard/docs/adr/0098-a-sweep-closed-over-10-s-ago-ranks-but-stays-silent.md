# A sweep closed over 10 s ago ranks but stays silent

After a relay gap or a lagged feed, sweeps arrive late in a burst, and that catch-up isn't news. A sweep whose second closed more than 10 s before the alert decision stays silent, but it still ranks among the side's sweeps.

Sites:
- `apps/dashboard/src/server/market-live/sweep-alerts.ts`

Source: apinrdw/kumora#502
