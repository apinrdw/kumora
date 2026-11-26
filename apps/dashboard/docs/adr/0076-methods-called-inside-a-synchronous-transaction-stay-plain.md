# Methods called inside a synchronous transaction stay plain

Code that runs inside the database's synchronous transaction stays plain, not an Effect, because an Effect can't run there. The day store's `Sql` port methods adapt synchronous third-party calls, and `transaction` runs its write inside that transaction; the store wraps every call in an Effect. The tape's `write`, `highestNumber`, `numbersBetween` and `rebuildCandleSides` are plain for the same reason: the day store's flush and the broker codes store's batches and summaries call them inside a transaction. The helpers they and a one-step scan use in `tape-chunks.ts` stay plain too. The tape's other methods are Effects.

Sites:

- `apps/dashboard/src/server/market-live/tape-backing.ts`
- `apps/dashboard/src/server/market-live/day-store.ts`
- `apps/dashboard/src/server/market-live/tape-chunks.ts`

Source: apinrdw/kumora#159
