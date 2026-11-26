# The live tape holds the newest 10,000 trades

The tape in the trading day's memory holds the newest 10,000 trades, the most the page keeps, and a restarted object reloads them from the day store. An older trade is still deduped, counted in its candle and merged, since the candle book holds it, but viewers aren't sent it.

Sites:

- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#157
