# walk_trades keeps a walk's fields the tape lacked

`walk_trades` keeps a walk's fields of each trade the tape lacked, the first row kept. On a day the relay recorded they never fill the tape, so its recorded answers don't change; only the build reads them. A walk day's batches fill its tape until its seal, and until then a row here holds none of its trades (`walkRowsHold`).

Sites:
- `apps/dashboard/src/server/market-live/broker-codes.ts`

Source: apinrdw/kumora#425, apinrdw/kumora#437
