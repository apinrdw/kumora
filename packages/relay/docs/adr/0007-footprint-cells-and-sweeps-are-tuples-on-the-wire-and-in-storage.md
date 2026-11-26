# Footprint cells and sweeps are tuples on the wire and in storage

A footprint minute is resent and rewritten whole, so its size matters on the wire and in storage. A footprint row stores its cells as one JSON text of `[price, sell, buy, none]` tuples ascending by price, and its sweeps as one JSON text of `[side, first trade, time, first, last, lots, value, trades]` tuples in trade order; the row is replaced whole, like a candle's. A busy code has under 1,000 cells and 10–18 K sweeps a day, a few hundred a minute. A sweep travels to viewers as the same tuple, not a keyed object: a delta resends a minute's sweeps whole, and a busy code's peak minute of 370 sweeps measured 21 KB a delta as tuples against 45 KB with the keys.

Sites:

- `apps/dashboard/src/server/market-live/footprint-cells.ts`
- `apps/dashboard/src/server/market-live/sweep-rows.ts`
- `packages/relay/src/envelope.ts`

Source: apinrdw/kumora#263, apinrdw/kumora#279
