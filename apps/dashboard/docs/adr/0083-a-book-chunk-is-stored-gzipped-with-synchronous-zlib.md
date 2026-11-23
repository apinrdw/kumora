# A book chunk is stored gzipped with synchronous zlib

A book chunk is stored gzipped, compressed with Node's zlib from the Worker's `nodejs_compat` flag. That zlib is synchronous, so a flush that writes chunks stays one transaction.

Sites:
- `apps/dashboard/src/server/market-live/day-store.ts`

Source: apinrdw/kumora#138
