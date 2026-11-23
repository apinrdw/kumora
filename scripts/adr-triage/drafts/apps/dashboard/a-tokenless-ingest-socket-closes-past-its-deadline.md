# A tokenless ingest socket closes past its deadline

A trading day object holds at most 32,768 sockets, and a client that never sends its token could fill them. The alarm closes an ingest socket still without its token with 4408 once `INGEST_TOKEN_DEADLINE` has passed since its accept instant, read from its tags. There is no cap on silent sockets, which would let such a client lock out the relay.

Sites:
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#157
