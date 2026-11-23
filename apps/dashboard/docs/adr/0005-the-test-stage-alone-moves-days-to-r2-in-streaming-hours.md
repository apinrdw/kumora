# The Test stage alone moves days to R2 in Streaming hours

The Test stage alone moves days to R2 in Streaming hours (`src/server/market-live/cold-window.ts`). Its market clock reads session 1 for the whole run, so the e2e's cold day would otherwise never move. No deployed stage binds it.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: none
