# An oversized code list is dropped

A code list whose encoding is over 2 MB is dropped with a log instead of stored. Ajaib's codes encode to about 0.2 MB, so a list ten times that is a wrong answer, not a list that grew. The cap also keeps the stored value well under the Durable Object's 8 MB limit per key and value.

Sites:
- `apps/dashboard/src/server/market-live/code-list.ts`

Source: apinrdw/kumora#157
