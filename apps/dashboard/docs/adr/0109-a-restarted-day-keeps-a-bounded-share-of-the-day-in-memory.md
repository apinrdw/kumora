# A restarted day keeps a bounded share of the day in memory

A Durable Object has 128 MB of memory, and a full day's candles kept as objects take about 180 MiB (measured 2026-11-10). So a restart reads back only the last-frame tables, one row per code, bounded by the code list; the day's candles stay in the store, read on demand by the candle book. A restarted object may keep at most 32 MiB of a full day on the heap, about a quarter of the limit. The bounded-memory tests define a full day as 900 codes trading every minute from the 08:58 match to post-trading's end, about 400,000 candles.

Sites:
- `apps/dashboard/src/server/market-live/trading-day.ts`
- `apps/dashboard/tests/server/market-live/recorded-day.test.ts`
- `apps/dashboard/tests/server/market-live/full-day.ts`

Source: https://developers.cloudflare.com/durable-objects/platform/limits/
