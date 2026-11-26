# The candle book holds a candle only while it can change

The live candle book keeps a candle in memory only while a trade of its is in the merge window or its figures changed since the last flush. Once the flush writes it, it leaves memory, and a later trade in that minute reads it back from the day store. Holding the whole day's candles would grow without bound on a Worker. A failed flush keeps its candles and trades until the write lands.

Sites:

- `apps/dashboard/src/server/market-live/candles.ts`

Source: apinrdw/kumora#157
