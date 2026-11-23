# A viewer's watchlist is capped and stored outside the socket

A watchlist holds at most 10,000 codes, about three times the 3,406 Ajaib lists; a `Select` past the cap fails to decode and its socket closes. The trading-day object keeps a viewer's codes in its storage under the socket's id, as one value, not in the socket's attachment: an attachment holds 16,384 bytes, about 2,300 codes, and a `Select` past it would throw after the snapshot, while a storage value holds 8 MB and the largest `Select` stores under 200 KB with 16-character codes. The object also reads a viewer message only up to 200,000 UTF-16 units, which the largest `Select` (190,081) fits, and closes a longer one with 1011 unread, so a viewer can't make it parse a 32 MiB message before the watchlist cap applies. 1011 retries with backoff, unlike the terminal 4401 and 4426.

Sites:
- `packages/relay/src/envelope.ts`
- `apps/dashboard/src/server/market-live/trading-day-object.ts`

Source: apinrdw/kumora#157
