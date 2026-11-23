# A day's tape shape is whether it holds a trades row

Days recorded before trade chunks store a row per trade; every later day is chunked. A day's tape shape is decided by whether it holds a `trades` row: an old day keeps its rows until it turns cold, and every other day is chunked. An empty `trades` table is dropped on start, so the check is one row read rather than a History walk of the empty table, which cost 18.9 M rows. Old days are never rewritten.

Sites:
- `apps/dashboard/src/server/market-live/tape.ts`

Source: apinrdw/kumora#555, apinrdw/kumora#634
