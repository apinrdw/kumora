# Sweep alerts live only in the object's memory

Sweep alerts live only in the trading-day object's memory, not in its store. A restarted object snapshots no alerts until it decides new ones, and an open page keeps the marks it had across the reconnect (`applyViewerMessage` in `lib/tape.ts`).

Standout sweeps, of which sweep alerts are the 1% ones, live the same way: the snapshot's backlog of them is in memory only, a restarted object starts it empty, and an open page keeps the rows it holds across the reconnect (`components/market-live/standout-store.ts`). See apinrdw/kumora#704.

Sites:
- `apps/dashboard/src/components/market-live/standout-store.ts`
- `apps/dashboard/src/server/market-live/kept-alerts.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#513, apinrdw/kumora#704, apinrdw/kumora#705
