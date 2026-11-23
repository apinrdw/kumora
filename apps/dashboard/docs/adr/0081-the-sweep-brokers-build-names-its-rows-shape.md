# The sweep brokers build names its rows' shape

The sweep brokers build's progress and finished value both name the rows' shape, with a new name whenever the rows' content changes. A day holding either under an older shape (`built`, a bare minute) counts as unbuilt, and its next sweep brokers GET rebuilds every row from its first minute. The build also runs before the seal, as broker codes land before it, so a day holding rows under an older shape never decodes them.

Sites:
- `apps/dashboard/src/server/market-live/day-store.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#384
