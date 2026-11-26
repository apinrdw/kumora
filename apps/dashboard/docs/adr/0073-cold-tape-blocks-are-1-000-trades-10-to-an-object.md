# Cold tape blocks are 1,000 trades, 10 to an object

A cold day's tape is stored in blocks of 1,000 trades in a row by number, the trades and their broker codes as one gzipped JSON body: 12 KB in the tests' day, about 18 KB for random fields. A page of 200 trades then spans at most two blocks. Blocks run back from the day's last trade, so the first block may hold fewer.

Blocks are stored 10 to an R2 object, a segment of 120 to 180 KB. The move holds one segment at a time, never a busy day's 18 to 26 MB of blocks, and writes about 150 objects (Class A writes) for the day. Reading one block is a range read, one GetObject (a Class B read) whatever the object's size.

Sites:

- `apps/dashboard/src/server/market-live/cold-tape.ts`

Source: apinrdw/kumora#585
