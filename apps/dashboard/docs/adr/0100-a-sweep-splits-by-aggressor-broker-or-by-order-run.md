# A sweep splits by aggressor broker, or by order run

A whole sweep splits by aggressor broker: each broker's members are one piece, however interleaved. Once every member has order numbers, the sweep splits by order run instead. An auction match has no aggressor, so it stays one piece.

Sites:
- `apps/dashboard/src/server/market-live/sweep-brokers.ts`

Source: apinrdw/kumora#384, apinrdw/kumora#627
