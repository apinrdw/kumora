# Durable Object constructors take no bindings

Cloudflare hands a Durable Object's constructor its bindings, but the trading day object's constructor takes none. Its start and every callback read `WorkerEnv`, which the runner provides, so no copy of a binding outlives the request that read it.

Sites:
- `apps/dashboard/src/server/market-live/trading-day-object.ts`

Source: apinrdw/kumora#585
