# The totals build holds one page of trades

The broker totals build holds one page of trades and one entry per (code, broker, investor type) and per code, never the day's trades, so its memory is bounded by codes × brokers. At the largest day the store accepts, 1.5 M trades over 900 codes and 90 brokers, it held about 15 MB (`broker-totals-memory.test.ts`).

Sites:

- `apps/dashboard/src/server/market-live/broker-totals.ts`

Source: none
