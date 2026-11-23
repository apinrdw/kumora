# A broker codes batch fits one byte limit on both sides

A broker codes batch holds at most 5,000 rows, one Ajaib page at `page_size=5000`; a Stockbit batch holds about 1,000. The Worker reads the body in chunks and drops it once it passes `BROKER_CODES_BATCH_LIMIT` bytes, before any of it is decoded, so a batch holds at most that much of the Worker's memory, and a full batch fits the limit. A batch is ASCII JSON, so its bytes are its UTF-16 units.

Sites:
- `packages/relay/src/broker-codes.ts`
- `apps/dashboard/src/server/market-live/broker-codes-route.ts`

Source: apinrdw/kumora#255
