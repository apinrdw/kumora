# Only listed codes join the recorded books set

The set of codes whose books a day records is stored as one fact, and a Durable Object SQLite row holds at most 2 MB. A code joins the set only if the day's code list names it, so the set holds listed codes alone: Ajaib's 3,406 and the indices. Before the list arrives, at most `UNLISTED_LIMIT` codes join. At 16 characters a code, the fact stays under 150 KB.

Sites:

- `apps/dashboard/src/server/market-live/recorded-books.ts`

Source: apinrdw/kumora#574
