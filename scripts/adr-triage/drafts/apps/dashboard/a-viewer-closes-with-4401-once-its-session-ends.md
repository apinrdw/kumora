# A viewer closes with 4401 once its session ends

A session that expires unread deletes no row, so the delete hook never fires for it. The market-live gate runs once, at the upgrade, and the viewer carries its session's `expiresAt`; the trading day object closes the socket with 4401 once that passes, when the viewer would next be served a delta or a snapshot, not by a timer, which hibernation would lose. A viewer tagged without an end is closed the same way.

The trade-off: an idle expired socket stays open, served nothing, until its next serve, and a session renewed after the upgrade still closes at the end the gate saw, so the page signs in again.

Sites:
- `apps/dashboard/src/server/market-live/gate.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#157
