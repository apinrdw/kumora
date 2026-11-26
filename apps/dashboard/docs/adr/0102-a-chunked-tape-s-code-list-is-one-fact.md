# A chunked tape's code list is one fact

A chunked tape's records index into the day's code list, which is stored as one fact: a JSON array, appended to in the transaction of the flush that first holds a code. A tape read loads it in one row, and a restart finds it beside the chunks that use it.

Sites:

- `apps/dashboard/src/server/market-live/tape-chunks.ts`

Source: apinrdw/kumora#574
