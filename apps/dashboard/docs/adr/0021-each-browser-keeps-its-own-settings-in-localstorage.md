# Each browser keeps its own settings in localStorage

Each browser keeps its own watchlist in localStorage, not on the account, and the other per-user settings follow it: the Speaker toggle (off until turned on), the chart settings under one key, the fill estimate order size (one amount per unit, so the Rupiah / Lots toggle goes back to the last amount in each), the order book radar's value floor, filters and Rank by, the last stock, and the book alerts' rules, chime and history. The e2e seeds or reloads these keys (`apps/e2e/tests/market-live-watchlist.spec.ts`, `apps/e2e/tests/market-live-footprint-controls.spec.ts`).

Sites:
- `apps/dashboard/src/components/market-live/use-watchlist.ts`
- `apps/dashboard/src/components/market-live/speaker-toggle.tsx`
- `apps/dashboard/src/components/market-live/use-chart-settings.ts`
- `apps/dashboard/src/components/market-live/use-order-size.ts`
- `apps/dashboard/src/components/order-book-radar/use-radar-settings.ts`
- `apps/dashboard/src/lib/last-stock.ts`
- `apps/dashboard/src/components/book-alerts/alert-store.ts`

Source: apinrdw/kumora#138, apinrdw/kumora#263, apinrdw/kumora#510, apinrdw/kumora#517
