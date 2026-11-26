# How Lightweight Charts 5.2.1 draws sweep bubbles, a book heatmap and footprint cells on 1-minute candles

Research for apinrdw/kumora#257 (map apinrdw/kumora#256), read 2026-11-13. Primary sources are the installed package (`node_modules/.pnpm/lightweight-charts@5.2.1/node_modules/lightweight-charts`: `dist/typings.d.ts` and `dist/lightweight-charts.development.mjs`), the library's docs and plugin examples at tag [`v5.2.1`][tag], and its release notes. Line numbers below refer to those two files in 5.2.1. `v5.3.0` came out on 2026-11-10. These notes stay on 5.2.1, the version in the catalog.

## Short answer

Every layer fits inside the library. None of them needs a canvas outside the chart.

| Layer                | API                                                                                                                                                                   | Draw layer                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Book heatmap         | A **series primitive** on the candle series, with a pane view whose `zOrder()` is `"bottom"`                                                                          | Below the grid and the candles |
| Sweep bubbles        | A **series primitive** on the candle series with `zOrder()` `"normal"`, plus `hitTest` for hover                                                                      | Just above the candles         |
| Footprint cells      | A **custom series** (`addCustomSeries`) with one data item per minute                                                                                                 | Series layer                   |
| Vol / Δ / CVD footer | A second **pane** in chart 2 (`chart.addPane()`), holding a small custom series that draws text, plus a series primitive's `priceAxisPaneViews` for the row labels    | Its own pane                   |
| VWAP ±1σ/2σ/3σ       | Seven built-in `LineSeries`, plus an optional series primitive that fills the bands in `drawBackground`                                                               | Series layer                   |
| Two stacked charts   | `subscribeVisibleLogicalRangeChange` → `setVisibleLogicalRange` both ways, and `subscribeCrosshairMove` → `setCrosshairPosition` / `clearCrosshairPosition` both ways | —                              |

The day holds about 330 one-minute candles. The cost is the number of shapes per redraw, not the number of bars. Each redraw repaints the main canvas of every pane in full. The top canvas, which carries the crosshair and `"top"` views, repaints on every mouse move. So keep heavy layers off `"top"`, keep `hitTest` cheap, and cache the heatmap.

## The building blocks in 5.2.1

- **Series primitive** (`ISeriesPrimitive`, `series.attachPrimitive`, typings 2591). It provides `paneViews`, `priceAxisPaneViews`, `timeAxisPaneViews`, axis label views, `autoscaleInfo`, `hitTest`, and `attached({ chart, series, requestUpdate })`. "Series primitives can also render on the price and time scales; pane primitives cannot." "If it decorates a series or reacts to its scales, build a series primitive" ([plugins intro][intro]; [series primitives][sprim]).
- **Pane primitive** (`IPanePrimitive`, `pane.attachPrimitive`, typings 2055). The same views, but it cannot draw on the axes. It gets only `{ chart, requestUpdate }` (`PaneAttachedParameter`, typings 3470), so it has no `priceToCoordinate` of its own ([pane primitives][pprim]). Every layer here is priced, so a series primitive fits better.
- **Custom series** (`ICustomSeriesPaneView`, `chart.addCustomSeries(view, options, paneIndex)`, typings 1629). Its own data type per time point, `priceValueBuilder` for autoscale, the crosshair and the price line, `isWhitespace`, and a renderer that gets `bars` (each with `x` and `originalData`), `barSpacing` and `visibleRange`. Its items "are expected to have a uniform width for each data point" ([custom series][custom]). The repo's agent skill calls it "heavier than a primitive — only use it when you need a true series API (data, scales, autoscale)" ([LWC SKILL.md][skill]).
- **zOrder** (`PrimitivePaneViewZOrder`, typings 4889): "`bottom`: Draw below everything except the background. `normal`: Draw at the same level as the series. `top`: Draw above everything (including the crosshair)." A renderer may also define `drawBackground`, which draws "beneath other elements on the same zOrder" ([series primitives][sprim]; typings 2309).
- **Panes** (`chart.addPane()` typings 1773, `addSeries(def, opts, paneIndex)`, `IPaneApi.setHeight` / `setStretchFactor` / `attachPrimitive`). Panes in one chart share its time scale. Separator color, hover color and resize are in `layout.panes` ([panes][panes]; typings 3222).

## (a) Sweep bubbles sized by lots at (time, price)

**Use a series primitive on the candle series.** The built-in markers come close but cannot place a sweep inside its minute:

- `createSeriesMarkers` accepts `position: "atPriceMiddle"` with `price`, and a `size` multiplier (typings 3947–3998). The drawn size is `calculateShapeHeight(barSpacing) * size`, where the base is the bar spacing clamped to 12–30 px (bundle 15526–15535 and 15818–15821). v5.2.1 stopped re-clamping the scaled size to 30 px ([v5.2.1 notes][r521]). So lot-sized circles are possible.
- But a marker's `time` "must match an existing data point's `time`" ([LWC SKILL.md][skill]). Every sweep in a minute lands on the same x, at the centre of the candle. Markers must also be sorted by time, or they misbehave ([#2006][i2006]). And before 5.0.4 they recomputed on every paint, which slowed charts with thousands of points ([#1808][i1808]). 5.2.1 also stopped copying the whole series on every mouse move ([v5.2.1 notes][r521]).

A primitive draws each sweep at its own second:

```ts
// x of a sweep at second s (0–59) inside its minute column
const centre = timeScale.timeToCoordinate(minuteTime) // exact data time, or null
const x = centre + ((s + 0.5) / 60 - 0.5) * timeScale.options().barSpacing
const y = series.priceToCoordinate(price)
// radius ∝ sqrt(lots), clamped; fill by aggressor side
```

- **Do not use a fractional logical index.** `timeScale().logicalToCoordinate(i + 0.25)` returns `0` in 5.2.1. `_internal_indexToCoordinate` returns `0` for any non-integer (bundle 6163–6166, `isInteger` at 207). `timeToCoordinate` needs a time that is on the time scale (bundle 13004–13009). So compute the offset from the minute's centre as above.
- **Side finding for the current chart.** `CursorLine` in `chart-canvas.tsx` calls `logicalToCoordinate` with `-0.5` or `n + 0.5` when the replay cursor sits between drawn minutes. In 5.2.1 that puts the line at x = 0, the left edge. Worth checking in the browser.
- **Hover.** Implement the primitive's `hitTest(x, y)` (typings 2780) and return `externalId`, `zOrder` and `hitTestPriority: 2` for point hits (typings 3819–3866). `subscribeCrosshairMove` then reports it as `hoveredInfo.objectId`. The library calls `hitTest` on every mouse move, so look the point up in a per-minute index rather than scanning every bubble.
- **Autoscale.** A sweep's price is a trade price inside that minute's high–low, so skip `autoscaleInfo`.
- **Density.** At the default bar spacing of about 6 px, a minute column is narrower than one bubble. Capping, thresholding or merging is a product rule for the map's "Peak behaviour" item.

## (b) A book heatmap behind the candles

**Use a series primitive on the candle series whose pane view returns `zOrder: "bottom"`.** The main canvas paints in this order: background, `"bottom"` views, grid, series with their `"normal"` primitives, then labels. The top canvas holds the crosshair and `"top"` views (bundle 9887–9909). A `"bottom"` view lies under the grid and the candles, and it does not repaint on crosshair moves.

The official [heatmap series example][heatmap] is a custom series. Each data item is `{ time, cells: [{ low, high, amount }] }`, drawn with one `fillRect` per cell in bitmap space and coloured by a `cellShader(amount)` option (`renderer.ts`). That shape fits a per-minute book well. But as a series it causes two problems here:

1. **It joins autoscale.** Its `priceValueBuilder` returns the lowest and highest cell. Resting levels far from the trades would squash the candles. You can override that with the series option `autoscaleInfoProvider: () => null` (typings 4166).
2. **It jumps above the candles on hover.** `hoveredSeriesOnTop` defaults to `true` since 5.2.0 and "renders the currently hovered series above other series in the same pane" ([v5.2.0 notes][r520]; typings 1023). A custom series without a `hitTest` hook, or one whose hook returns `null`, falls back to a hit test over the full span of its `priceValueBuilder` (bundle 12149–12173). Hovering anywhere inside a heatmap column would draw the heatmap over the candles. The only fix is `hoveredSeriesOnTop: false` for the whole chart.

A primitive has neither problem. It gets prices from `series.priceToCoordinate` and minute x from `timeToCoordinate`, as `SessionLines` and `GapShades` already do in `chart-canvas.tsx`. Each live book frame overwrites the current minute's column and calls `requestUpdate()`.

**Cost.** About 200 visible minutes times 40–80 visible price levels is 8,000–16,000 `fillRect` calls per repaint. `requestUpdate` triggers a full update (bundle 12601, 12870), and the chart coalesces repaints to one animation frame (bundle 11196). The heatmap therefore repaints on every live candle update, every pan and every zoom. Two in-library ways to bound it, both following [MDN's canvas advice][mdn] to "pre-render … on an offscreen canvas" and "avoid unnecessary canvas state changes":

- Keep the closed minutes as an `ImageData` of one pixel per (minute, price level) on an offscreen canvas. Draw it with a single scaled `drawImage` with smoothing off, then paint only the live column by hand.
- Or sort cells into a few colour buckets, so each bucket sets `fillStyle` once.

## (c) Footprint cells, the footer row and VWAP ±σ in chart 2

**Footprint cells: a custom series.** Each minute is one item, for example `{ time, open, high, low, close, levels: [{ price, sell, buy }] }`. This is what a custom series is for: one data item per time point, with its own drawing. It gets:

- `priceValueBuilder` → `[low, high, close]`, so autoscale, the crosshair and the price line behave like a candle.
- The renderer gets every bar's `x`, `barSpacing` and `visibleRange`. Draw only `visibleRange.from`–`to`, as the heatmap example does.
- `series.update(item)` per minute, like the candle store's deltas today. `update(item, true)` rewrites an earlier minute.
- The modes (Stacked, Side by side, Footprint, Candles) become a series option read in `update(data, options)` and changed with `applyOptions`. Candles mode can hide the series (`visible: false`) and show a plain `CandlestickSeries`.
- Text only fits when the column is wide. A cell such as "1,234 × 5,678" needs a bar spacing of roughly 60–100 px, and a row height of roughly 10 px per price level. The heatmap example already turns off cell borders when `barSpacing` is small. The footprint renderer should do the same with text, falling back to coloured bars. MDN's list says "avoid text rendering whenever possible" ([mdn]). Text is the most expensive part of this layer.
- Imbalance highlights are a colour choice per cell inside the same renderer.

**Vol / Δ / CVD footer: a second pane in chart 2.** `chart.addPane()` adds a pane below, with the same time scale and a crosshair that crosses both panes. Give it a fixed height with `pane.setHeight(…)`, or `setStretchFactor` (typings 2025, 2107). Put a small custom series in it, `addCustomSeries(footerView, opts, 1)`, whose renderer writes three text rows per visible bar at that bar's `x`. Give it a constant `priceValueBuilder` such as `[0, 1]` and hide its price scale. A series primitive on that footer series draws the row labels ("Vol", "Δ", "CVD") in the price-scale strip through `priceAxisPaneViews` (typings 2733). Only series primitives can draw there ([intro]). Without a second pane, you would reserve a band with the candles' `scaleMargins.bottom` and draw the footer from the footprint renderer at the bottom of the bitmap. That works, but the footer then moves with price-scale margins.

**Day VWAP with ±1σ/2σ/3σ: seven `LineSeries`** (VWAP and six bands), each with `lastValueVisible: false` and `priceLineVisible: false`. The values come from per-minute running sums. These get crosshair values for free. For shaded bands, use a series primitive whose renderer fills between two band lines in `drawBackground`, as in the official [bands indicator example][bands]. That example maps every point on each update. Map only the visible range.

## How two stacked charts share time scale and crosshair

The official recipe is the tutorial [Syncing two charts][sync] (source [`set-crosshair-position-syncing.js`][syncsrc]):

```js
chart1.timeScale().subscribeVisibleLogicalRangeChange(r => chart2.timeScale().setVisibleLogicalRange(r));
chart2.timeScale().subscribeVisibleLogicalRangeChange(r => chart1.timeScale().setVisibleLogicalRange(r));
chart1.subscribeCrosshairMove(p => {
  const d = p.time ? p.seriesData.get(series1) : undefined;
  d ? chart2.setCrosshairPosition(d.value, d.time, series2) : chart2.clearCrosshairPosition();
});
// and the mirror for chart2 → chart1
```

What the source adds:

- `setCrosshairPosition(price, time, series)` (typings 1817) snaps to the nearest time (`timeToIndex(…, true)`). It saves the position with `skipEvent = true` (bundle 7091–7097), and `clearCrosshairPosition` also skips (bundle 13310–13311). The synced crosshair never fires the other chart's `subscribeCrosshairMove`, so the two-way crosshair wiring cannot loop. Pass candle prices (`close`) from a candle series on each side. The second chart's footprint is a custom series whose `seriesData` value is the custom item.
- The two logical-range handlers do call each other. The agent skill wraps them in a `syncing` flag and skips `null` ranges ([LWC SKILL.md][skill], "Sync separate charts or panes").
- **A logical range is bar indices, not time.** Both charts must hold the same time points in the same order, including the gap whitespace bars that `chart-canvas.tsx` inserts. Otherwise index 120 is a different minute in each chart. If that can't hold, sync with `getVisibleRange` / `setVisibleRange` (time) instead.
- **Columns line up only at the same plot width.** Set `rightPriceScale.minimumWidth` to the same value on both charts. It exists "for ensuring that multiple charts positioned in a vertical stack each have an identical price scale width" (typings 3790–3798). The Buy/Sell sweep log beside chart 1 must not narrow chart 1's plot area relative to chart 2. Otherwise both charts show the same minutes at different bar spacings.
- The alternative is one chart with panes: candles, bubbles and heatmap in pane 0, and the footprint and footer in panes 1–2. The time scale and crosshair are then shared natively, with no sync code. The owner's standing choice is two charts. This is the fallback if the sync drifts.

## Known performance limits

There is no published ceiling for primitives or custom series. What the source and notes do establish:

- **Bars are not the bottleneck.** Conflation (5.1, `enableConflation`, off by default) exists for ">10K points" ([v5.1.0 notes][r510]; typings 1499–1539). A day of 1-minute candles is about 330 bars, so leave it off. A custom series would need a `conflationReducer` anyway.
- **Every main-canvas repaint redraws everything.** `requestUpdate()` triggers a full update, and repaints run at most once per animation frame (bundle 12601, 12870, 11196). Live candle deltas, live book frames and new sweeps each cause one. Batch them per frame, as `chart-canvas.tsx` already does for candles.
- **Mouse moves repaint only the top canvas** (crosshair and `"top"` views) and run every `hitTest` (bundle 9887–9909, 7062–7084). Keep `"top"` views tiny, as the cursor line is, and index hit tests.
- **Custom series `update` maps all bars** each full update (bundle 12190–12197). That is cheap at 330 bars. Keep per-bar data small, with no per-draw allocation of cell arrays. The heatmap example's `bars.map` on every draw is the pattern to avoid.
- **The shape budget is plain canvas 2D.** Rectangles are cheap, `fillText` is costly, and state changes add up ([mdn]). Rough per-repaint load at the open: heatmap 10⁴ rects, which needs the offscreen cache above; bubbles up to 10³ arcs; footprint about 15 wide columns × 30 levels × 2 numbers = 900 `fillText` calls. The data-volume ticket's peak counts should confirm the bubble and level numbers. No primary source gives frame-time figures, so the first prototype must measure them.
- **Markers** were slow with thousands of data points until 5.0.4 ([#1808][i1808]; duplicate [#2077][i2077]). 5.2.1 removed their per-mouse-move data copy ([v5.2.1 notes][r521]). They are still the wrong tool for sub-minute bubbles (see a).

## Does anything need a canvas overlay outside the library?

No. All drawing fits in primitives, custom series and panes, and layers are ordered with `zOrder` and `setSeriesOrder` (typings 2623). The agent skill says to sync charts "with public time-scale events" and to avoid `paneWidgets` or DOM offset hacks ([LWC SKILL.md][skill]). An outside canvas would also miss the chart's DPR handling and pixel-perfect bitmap scope ([canvas rendering target][crt]). The only DOM on top of the chart should be HTML tooltips, positioned from `subscribeCrosshairMove` as in the official tooltip examples (`website/examples/tooltips-and-legends`, listed in [LWC SKILL.md][skill]). The sweep log is ordinary DOM beside chart 1.

## Confidence

| Claim                                                                              | Basis                                              | Confidence                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| API shapes (primitives, custom series, panes, zOrder, crosshair, `minimumWidth`)   | 5.2.1 `typings.d.ts`                               | High                                                    |
| Paint order, top-canvas-only repaint on mouse move, full update on `requestUpdate` | 5.2.1 development bundle                           | High                                                    |
| `logicalToCoordinate` returns 0 for fractional logicals                            | Bundle 6163–6166; not run in a browser             | High from source; the `CursorLine` effect is unverified |
| Hovered custom-series heatmap jumps over candles                                   | 5.2.0 notes plus bundle fallback hit test; not run | High from source                                        |
| Synced crosshair does not echo events                                              | Bundle `skipEvent` paths                           | High                                                    |
| Shape counts at the open and their frame cost                                      | Estimates, no measurement                          | Low; needs the prototype and the data-volume ticket     |

[tag]: https://github.com/tradingview/lightweight-charts/tree/v5.2.1
[intro]: https://tradingview.github.io/lightweight-charts/docs/plugins/intro
[sprim]: https://tradingview.github.io/lightweight-charts/docs/plugins/series-primitives
[pprim]: https://tradingview.github.io/lightweight-charts/docs/plugins/pane-primitives
[custom]: https://tradingview.github.io/lightweight-charts/docs/plugins/custom_series
[crt]: https://tradingview.github.io/lightweight-charts/docs/plugins/canvas-rendering-target
[panes]: https://tradingview.github.io/lightweight-charts/docs/panes
[sync]: https://tradingview.github.io/lightweight-charts/tutorials/how_to/set-crosshair-position
[syncsrc]: https://github.com/tradingview/lightweight-charts/blob/v5.2.1/website/tutorials/how_to/set-crosshair-position-syncing.js
[heatmap]: https://github.com/tradingview/lightweight-charts/tree/v5.2.1/plugin-examples/src/plugins/heatmap-series
[bands]: https://github.com/tradingview/lightweight-charts/blob/v5.2.1/plugin-examples/src/plugins/bands-indicator/bands-indicator.ts
[skill]: https://github.com/tradingview/lightweight-charts/blob/master/.github/skills/lightweight-charts/SKILL.md
[r510]: https://github.com/tradingview/lightweight-charts/releases/tag/v5.1.0
[r520]: https://github.com/tradingview/lightweight-charts/releases/tag/v5.2.0
[r521]: https://github.com/tradingview/lightweight-charts/releases/tag/v5.2.1
[i1808]: https://github.com/tradingview/lightweight-charts/issues/1808
[i2077]: https://github.com/tradingview/lightweight-charts/issues/2077
[i2006]: https://github.com/tradingview/lightweight-charts/issues/2006
[mdn]: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
