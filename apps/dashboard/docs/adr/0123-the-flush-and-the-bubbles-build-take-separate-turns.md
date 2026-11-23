# The flush and the bubbles build take separate turns

Once a minute, 5 s past it, the trading day flushes and then builds the bubbles answer. One turn held both, and at 13:31:05, the first heavy flush after the break, that turn held the object for 2.5 to 3.8 s. Production's Workers Logs from 2026-11-16 to 11-19 show the relay's ingest socket closing with 1006 inside that turn, and bubbles GETs failing with "Durable Object is overloaded", so every recorded day lost its trades in a 3 to 4 s relay gap. The timer body now takes the turn for the flush, yields to the event loop, then takes it again for the build, so relay messages that came during the flush run before the build. The second take comes after the first turn is given back, never while it is held (ADR-0110). The build reads `settledBefore` when it runs, so its body still holds every trade before it (ADR-0029).

Sites:
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#603
