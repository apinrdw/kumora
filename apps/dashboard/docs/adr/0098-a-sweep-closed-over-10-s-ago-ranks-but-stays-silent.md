# A sweep closed over 10 s ago ranks but stays silent

After a relay gap or a lagged feed, sweeps arrive late in a burst, and that catch-up isn't news. A sweep whose second closed more than 10 s before the alert decision stays silent, but it still ranks among the side's sweeps.

Silent means no sound and no tape mark only. Such a sweep still stands out at the level it reached and the All codes tab lists it, since that list shows everything that stood out (apinrdw/kumora#705).

Sites:

- `apps/dashboard/src/server/market-live/sweep-alerts.ts`

Source: apinrdw/kumora#502
