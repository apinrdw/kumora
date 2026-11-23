# The codes-complete fact is written per batch

Each broker codes batch writes the codes-complete fact in its own transaction, so a woken object answers from one row. A batch never clears codes, so on a complete day a batch that doesn't raise N reads 1 row; otherwise it recounts, up to every chunk, about 1,500 rows on a busy day. A day whose batches came before the fact existed reads its chunks once and writes the fact, about 1.46 K rows read and 2 written on a busy day, and the next GET reads the fact; a day with no N reads 1 row and writes nothing (`row-budgets.workerd.test.ts`).

Sites:
- `apps/dashboard/src/server/market-live/broker-codes.ts`

Source: apinrdw/kumora#554
