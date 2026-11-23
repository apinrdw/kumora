# An Ajaib book is stored whole per on-demand code

An Ajaib book is stored whole, every level and its as-of time, one row per on-demand code, replaced by each flush that saw it change. Ajaib sends a whole book only on subscribing, and a restarted object keeps its hibernated socket, so no whole book comes again. The served book's 20 levels can't carry later deltas on, so the full book must be stored.

Sites:
- `apps/dashboard/src/server/market-live/order-books.ts`

Source: apinrdw/kumora#157
