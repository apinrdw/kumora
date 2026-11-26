# The Staging cost check reads meter lines from Workers Logs

The Staging cost check reads the day store's meter figures from Workers Logs: one line per flush or, after the seal, per sweep brokers recompute, as the feed lag lines do (apinrdw/kumora#231). Each line carries each billed meter figure and the database count it adds up. This needs no binding or route, and a restart loses at most one line's counts. The check is described in `docs/runbooks/order-flow-cost.md`.

Sites:

- `apps/dashboard/src/server/market-live/day-store.ts`

Source: apinrdw/kumora#231, apinrdw/kumora#270
