# Broker codes are stored as 7-byte records in 1,000-trade chunks

A day's broker codes are stored in chunks: chunk k holds trades 1000k+1 .. 1000k+1000 as 1,000 fixed 7-byte records of buyer code, buyer type, seller code, seller type and source, with all zero bytes for an absent trade. A batch rewrites only the chunks it touches: 1–2 per Stockbit batch, up to 6 per Ajaib batch of 5,000. The source byte is `A` for Ajaib's, `S` for Stockbit's, and `B` for Ajaib's that Stockbit's copy agreed with; the cross-check counts its covered trades from it, so a resent Stockbit batch counts none twice. The row budgets' busy day (`billing/busy-day.ts`) writes its chunks in this layout.

Sites:

- `apps/dashboard/src/server/market-live/broker-codes.ts`

Source: none
