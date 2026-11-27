# Lightweight Charts runs only in the browser

Lightweight Charts runs only in the browser, in its own chunk: the Worker's server render never imports it, and other pages never load it. Both the candle chart and the footprint chart load it this way.

Sites:

- `apps/dashboard/src/components/market-live/live-chart.tsx`
- `apps/dashboard/src/components/market-live/footprint-chart.tsx`

Source: apinrdw/kumora#138
