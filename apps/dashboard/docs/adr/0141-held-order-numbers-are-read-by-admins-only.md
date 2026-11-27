# Held order numbers are read by admins only, uncached, from a hot day

Each trading-day object keeps every trade's buy and sell order numbers and the source byte that says whose they are (`A`, `S`, `B` or `D`, packages/relay ADR 0005), but no viewer answer serves them. Research into the relay extension's Done Details matcher needs them: its pairings can only be judged against Stockbit's order numbers, which Production alone holds. So one Worker route, `GET /api/admin/order-numbers/<date>?after=<n>&limit=<n>`, answers them a page of up to 50,000 trades at a time, each as `[trade, buy, sell, source letter]`.

It is a read for admins, not a Market Live answer: it is gated by the access policy's `admin.read-order-numbers`, read past the cookie cache like the admin pages, and a signed-out request gets 401, any other account 403. Every answer is `private, no-store`, so no shared or browser cache keeps Production order numbers for another visitor. It writes nothing. A day moved to R2 answers 404 `NotAvailable`, because the move keeps no order numbers in the cold archive; adding them there would grow every cold day for a research read. A `D` record answers Ajaib's numbers alone: Stockbit's that differed are not kept (`cross_check_differences` holds broker codes only).

Sites:

- `apps/dashboard/src/server/market-live/order-numbers-route.ts`
- `apps/dashboard/src/server/market-live/broker-codes.ts`

Source: none
