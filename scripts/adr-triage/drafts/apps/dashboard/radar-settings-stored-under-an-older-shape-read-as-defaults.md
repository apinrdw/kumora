# Radar settings stored under an older shape read as defaults

Radar settings stay in each browser's localStorage, so a browser can hold a shape the scanner no longer offers. A stored Rank by the scanner dropped (Near depth bid or offer under either stored name, Empty ticks, Spread %) reads as Imbalance, and settings stored before the Heavy side filter read it as Any. The browser's other settings are kept, and its next change stores the new shape.

Sites:
- `apps/dashboard/src/components/order-book-radar/use-radar-settings.ts`

Source: apinrdw/kumora#601
