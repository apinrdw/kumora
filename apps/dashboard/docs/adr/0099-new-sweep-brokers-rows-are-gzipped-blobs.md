# New sweep brokers rows are gzipped BLOBs

A new sweep brokers row stores its sweeps as a gzipped BLOB of the same text, with the zlib the day store gzips book chunks with. A day recorded before holds plain-text rows, which are read as they are and never rewritten. `SWEEP_BROKERS_SHAPE` is not bumped for the change, because a bump would rebuild every old day.

Sites:

- `apps/dashboard/src/server/market-live/sweep-brokers.ts`

Source: apinrdw/kumora#555
