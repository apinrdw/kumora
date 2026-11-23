# Each session's end stores one book row per code

Books are recorded only for viewed codes. At each session's end the day store writes one row per code whose book was served in that session, about 900 rows at the break and 900 at the close, rather than storing every chunk of every code. A restart brings back every code's book and readings from those rows, then from any newer recorded chunk (`restoreLastFrames` in `trading-day.ts`). An unviewed code has no chunk, so its book comes back from the last session's end (`session-books.ts`); a code first served after that end is missing until its next frame, and its Ajaib book is served meanwhile.

Sites:
- `apps/dashboard/src/server/market-live/day-store.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#555
