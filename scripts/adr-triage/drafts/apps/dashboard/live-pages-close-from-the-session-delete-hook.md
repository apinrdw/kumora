# Live pages close from the session delete hook

Live pages close from the session table's delete hook, not from a table of routes: every route that ends a session deletes its row through that hook, after its transaction. The hook sends the sessions still held, read after the delete, so a failed route ends nothing. A session that expires unread deletes no row, so the viewer gate and the trading day object close that one (see the 4401 decision).

Sites:
- `apps/dashboard/src/server/auth/options.ts`

Source: apinrdw/kumora#157
