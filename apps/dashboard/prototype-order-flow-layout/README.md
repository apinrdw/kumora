# PROTOTYPE: order flow layout (throw away, never merge)

Question (apinrdw/kumora#260, map #256): how should Market Live lay out the two stacked charts and the Buy/Sell sweep log? Chart 1 shows candles, the book heatmap and sweep bubbles. Chart 2 shows candles with the footprint and a Vol / Δ / CVD footer. The log is the selected code's sweeps. The right column (watchlist, order book, tape) stays.

The data is real: SINI on recorded day 2026-11-13 (`data.js`). It holds 261 one-minute candles, 4,459 sweeps (18 of them big trades ≥ Rp1 B), footprint cells, and 1,566 time-weighted 10 s heatmap slices. Times are in WIB.

## Run

```sh
python3 -m http.server 8765 --directory apps/dashboard/prototype-order-flow-layout
```

Open <http://localhost:8765/?variant=A>. Lightweight Charts 5.2.1 loads from unpkg, so you need a network connection.

URL keys:

- `variant=A|B|C` picks the layout. Switch with the bottom bar or the ← and → keys.
  - **A**: chart 1 and the log sit side by side. Chart 2 sits below in chart 1's grid column, so it has the same width. The space under the log holds chart 2's readout (the hovered minute's OHLC, lots, Buy, Sell, Δ, CVD).
  - **B**: both charts are stacked in one column. The log is a full-height column between the charts and the right column.
  - **C**: both charts run full width on top. Below them is one row with the log, watchlist, order book and tape side by side.
- `zoom=day|open60|open15|busy` sets the starting range. `busy` is the 15 minutes around the minute with the most sweeps (10:59).
- `cursor=HH:MM` sets where the replay cursor starts. The slider moves it in 10 s steps.

The dashed strip at the top shows the state: variant, visible range and px per bar, cursor, both plot widths (they must match), selected sweep, the last full and crosshair-only repaint of each chart, and the shapes drawn. **Bench** pans 120 frames and reports p50 / p95 / max of each chart's full repaint.

## Built as the research said (#257)

- Heatmap: a `zOrder: "bottom"` series primitive on the candles. It batches cells into 16 colour buckets (8 levels per side, √(lots / p98)), with one path fill per bucket. Below 1.5 bitmap px per 10 s slice, it draws the minute average as one column instead.
- Bubbles: a `"normal"` series primitive. x is the minute centre plus `((s + 0.5) / 60 − 0.5) · barSpacing`, y is the sweep's average price. Area is proportional to lots (r = 0.25·√lots, clamped to 1.5–24 px). Big trades get an amber ring. `hitTest` checks only the neighbouring minutes, and a click on a bubble selects its log row.
- Footprint: a custom series that draws the candle too. At ≥ 56 px per bar and ≥ 8 px per tick it writes `sell × buy` text, at ≥ 9 px per bar it draws stacked bars, and below that only candles. The footer is a custom series in pane 1, with row labels drawn through `priceAxisPaneViews`.
- Sync: logical range both ways with a guard flag, and crosshair both ways, using the hovered price. Both charts set `rightPriceScale.minimumWidth: 72`.
- Repaint timing: a stamp primitive's first draw in a paint marks t0, and a microtask after the chart's rAF callback marks the end.

## What it showed (headless Chromium 1680×1050, no CPU throttle)

Full repaint p50 / p95 / max in ms, 120-frame pan:

| Zoom | Chart 1 (heatmap + bubbles) | Chart 2 (footprint + footer) |
| --- | --- | --- |
| Day, 261 bars, ~3 px/bar (6.5 K heat rects, 3.9 K bubbles) | 2.1–2.6 / 2.4–5.4 / 3.5–10 | 0.4–0.5 / 0.5–1.1 / 0.7–3.9 (one 38 ms outlier in A) |
| Busiest 15 min (3.2 K rects, 1.0 K bubbles) | 0.8 / 1.0–1.3 / 1.7–2.0 | 0.3–0.5 / 0.4–0.7 / 0.6–1.7 (C: 336 fillText) |
| Open 15 min | 0.5 / 0.6 / 1.0 | 0.2 / 0.4 / 1.0 |

- Draw cost doesn't decide the layout. Chart 1 stays under 3 ms p50 even at full-day zoom, so the offscreen heatmap cache isn't needed for SINI yet. BBCA at the open is still untimed.
- In A and B the plot is about 845 px wide, so 15 bars come out at about 48 px each and the footprint stays in bar mode. You need about 12 or fewer bars for text. C's full width (about 1,610 px) gives 96 px per bar, and text shows at 15 bars.
- A 340 px log still truncates a 4-digit-lot sweep that walks two 5-digit prices (`1,310 @ 10,925→10,9…`). The log needs about 360 px, or a shorter price form.
- A row click scrolls both charts to the sweep's minute (a 30-bar window when zoomed out wider than 60 bars), rings the bubble, and drops a dashed guide.

Screenshots: `variant-A.png`, `variant-B.png`, `variant-C.png` (busiest 15 min, cursor 14:30), `variant-B-open15.png`, `variant-A-row-click.png`. `shoot.mjs` regenerates them and prints the bench (`node shoot.mjs <path to the playwright package>`, with the server running).
