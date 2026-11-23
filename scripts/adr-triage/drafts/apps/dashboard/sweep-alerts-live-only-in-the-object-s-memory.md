# Sweep alerts live only in the object's memory

Sweep alerts live only in the trading day object's memory, not in its store. A restarted object snapshots no alerts until it decides new ones, and an open page keeps the marks it had across the reconnect (`applyViewerMessage` in `lib/tape.ts`).

Sites:
- `apps/dashboard/src/server/market-live/kept-alerts.ts`

Source: apinrdw/kumora#513
