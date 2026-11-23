# Tape chunks hold fixed 32-byte records with append-only enums

A day's tape is stored in chunks: chunk k holds trades 1000k+1 to 1000k+1000 as fixed 32-byte records placed by trade number, and all zero bytes is a trade the tape lacks. A flush rewrites only the chunks it adds trades to, about 4 a minute on a busy day. A record stores a trade's side, board and feeds as their index in `Side`, `Board` and `TradeSource`, and packs at most four feeds. So each of those lists is append-only: a stored day reads its records back through the order it was written with.

Sites:
- `apps/dashboard/src/server/market-live/tape-chunks.ts`
- `packages/relay/src/envelope.ts`

Source: apinrdw/kumora#555
