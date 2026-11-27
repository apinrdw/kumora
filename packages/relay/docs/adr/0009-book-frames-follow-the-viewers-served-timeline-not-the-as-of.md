# Book frames follow the viewers' served timeline, not the as-of

A served order book can be older than the one served before it, as when the object falls back to Ajaib's book while Stockbit's goes stale. So a book frame joins the chunk of the minute it was served in, by the trading-day object's clock, not by the book's as-of, and replay runs on the served instant. A code's deltas then follow the viewers' timeline, and a replay cursor is an instant on the viewers' clock.

Sites:

- `packages/relay/src/recorded-day.ts`
- `apps/dashboard/src/server/market-live/book-chunks.ts`

Source: apinrdw/kumora#157
