# The Test stage alone takes a Market Live clock offset

The Test stage alone takes a Market Live clock offset in milliseconds, so the e2e can open the page in a chosen market phase; no deployed stage can shift its market clock. `apps/e2e/support/clock.ts` sets the offset, `turbo.json` passes it through, and `src/server/market-live/market-clock.ts` applies it.

Sites:

- `apps/dashboard/alchemy.run.ts`

Source: none
