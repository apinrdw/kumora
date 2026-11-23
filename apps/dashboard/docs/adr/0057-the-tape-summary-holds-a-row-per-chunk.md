# The tape summary holds a row per chunk

The tape summary holds one row per chunk the tape holds a trade of: how many of its numbers the tape holds, and the runs it lacks as JSON `[first, last]` pairs. A row stands for the tape only once the `tape-summary` fact says so (`TAPE_SUMMARY_BUILT`). There is no migration: a day sealed before the tape summary builds it at its first status pass with one scan of the tape, about 1.46 M rows read and 1,460 written on a busy day, as the seal's `summarizeTape`; later passes read about 3 K rows. A relay day before its seal scans its growing tape instead, 2.7 M rows for a busy day's whole (`unfieldedOf`).

Sites:
- `apps/dashboard/src/server/market-live/broker-codes.ts`

Source: apinrdw/kumora#543
