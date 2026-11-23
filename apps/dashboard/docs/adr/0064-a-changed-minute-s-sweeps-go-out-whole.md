# A changed minute's sweeps go out whole

When a minute's sweeps change, every delta sends that minute's sweeps whole, and the page replaces its copy. The candle book is then the only place sweeps are grouped, so the page's join can't leave a gap or count a sweep twice. A peak minute of 370 sweeps measured 21.7 KB in its last delta and 11.0 KB a delta over its 240 deltas (`sweeps.test.ts`).

If that proves too heavy, the fallback is to send a minute's sweeps at most once a second.

Sites:
- `apps/dashboard/src/server/market-live/candles.ts`

Source: apinrdw/kumora#279
