# Broker totals and candles keep the regular board only

The build keeps only the regular board, which holds the auction matches too. Negotiated (NG) and cash (TN) trades count in neither broker totals nor candles.

Sites:
- `apps/dashboard/src/server/market-live/broker-totals.ts`

Source: apinrdw/kumora#437
