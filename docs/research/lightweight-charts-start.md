# Lightweight Charts in a TanStack Start page on Workers

Research for #42 (map #38, Market Live). Read 2026-11-06.

## Verdict

Use `lightweight-charts@5.2.1` (npm `latest`, released 2026-08-12). Importing the package is SSR-safe. `createChart` is not. Build the chart in a `useEffect` inside TanStack's `<ClientOnly>`. Call `setData` once with the relayed history, then `update` once per trade on the current 1-minute bar. Time is UTC seconds. Show WIB with `Intl.DateTimeFormat` formatters, and do not shift the timestamps. Keep `attributionLogo: true` and add the NOTICE text to the page. Read token colours with `getComputedStyle`, because canvas cannot resolve `var(--x)`.

## Version and package

- npm `lightweight-charts`: `latest` = **5.2.1**. Earlier releases: 5.2.0 (2026-04-24) and 5.1.0 (2025-12-16). Stale dist-tags: `next` = 5.0.7-rc1 and `next-v5` = 5.0.0-rc3. (`npm view lightweight-charts dist-tags time`)
- Apache-2.0. ESM-only (`"type": "module"`, `exports` with `development` / `production` / `default` conditions). One dependency: `fancy-canvas@2.1.0`. (`package.json` in the 5.2.1 tarball)
- The production build is 189 kB raw and about 60 kB gzipped (measured on `dist/lightweight-charts.production.mjs`).
- 5.2.1 notes: crosshair and hover no longer clone the whole dataset on each mouse move when series markers are present. They also fix a `Value is null` error when shorter datasets replace longer ones under the crosshair. 5.2.0 notes: `autoSize` resize now paints synchronously, which removes jitter in dynamic containers. (GitHub releases v5.2.1, v5.2.0)
- Upstream now ships an agent skill: `.github/skills/lightweight-charts/SKILL.md` in `tradingview/lightweight-charts`. It is the source of several items in the footguns section below.

## v5 API surface used here

From `dist/typings.d.ts` (5.2.1):

- `createChart(container: string | HTMLElement, options?: DeepPartial<ChartOptions>): IChartApi`
- `chart.addSeries(CandlestickSeries | HistogramSeries, options?, paneIndex?)`. The series definitions are named exports (`CandlestickSeries`, `HistogramSeries`). The v4 methods `addCandlestickSeries` and others are gone.
- `series.setData(data: TData[])` replaces all data. Items must be in ascending time order.
- `series.update(bar: TData, historicalUpdate?: boolean)` appends when `time` is greater than the last time and replaces the last bar when `time` equals it. `historicalUpdate: true` can edit an older bar, but more slowly, and it cannot insert a missing bar.
- `chart.remove()` destroys the chart. `chart.applyOptions(...)` changes options. With `autoSize: true` the chart sizes itself to its container through `ResizeObserver`.
- `type Time = UTCTimestamp | BusinessDay | string`. `UTCTimestamp` is a branded `number` of **seconds**.
- Data shapes: `CandlestickData { time, open, high, low, close, color?, borderColor?, wickColor? }` and `HistogramData { time, value, color? }`.

## Client-only mount in TanStack Start

Checked against Node 26:

```
import("lightweight-charts")  -> ok, version() = "5.2.1"
createChart(null)              -> throws "document is not defined"
```

The module does not touch `window` or `document` when it loads. It does at `createChart`. A route can therefore import the module statically, which keeps types and server rendering intact. The chart must only be created in browser code.

`@tanstack/react-router` (1.170.46 on npm) exports `ClientOnly({ children, fallback })` and `useHydrated()`. Its doc comment uses a chart as the example: `<ClientOnly fallback={<FakeChart />}><Chart /></ClientOnly>`. `useHydrated()` is `false` during SSR and on the first client render, then `true`.

Recommended shape:

```tsx
import { ClientOnly } from "@tanstack/react-router"

// Route component: the server renders the fallback at the same size, so the layout does not shift.
<ClientOnly fallback={<div className="h-[420px]" />}>
  <LiveCandleChart stockCode={code} />
</ClientOnly>
```

```tsx
// LiveCandleChart: create the chart once and remove it on cleanup.
useEffect(() => {
  const el = ref.current
  if (!el) return
  const chart = createChart(el, { autoSize: true, ...themeOptions(el) })
  const candles = chart.addSeries(CandlestickSeries, candleOptions)
  const volume = chart.addSeries(HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "", // overlay on a hidden scale
  })
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } })
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.3 } })
  seriesRef.current = { candles, volume }
  return () => {
    seriesRef.current = null
    chart.remove()
  }
}, [])
```

`useEffect` alone never runs on the server, so `ClientOnly` is not strictly needed for safety. It does give a clear SSR fallback and keeps the effect from running before hydration. The upstream skill says: "Create the chart once in `useEffect` … destroy it in cleanup with `chart.remove()`. Recreating on every render duplicates DOM and leaks listeners."

Bundle option: a static import puts about 60 kB gzipped into the Worker's server bundle and into the Market Live route chunk. `const { createChart, ... } = await import("lightweight-charts")` inside the effect keeps it out of both. That variant needs an "unmounted before import resolved" guard. The static import is simpler, and Market Live is the only consumer (#38: "Lightweight Charts on Market Live only").

The volume overlay comes from upstream `website/examples/price-scales/price-and-volume.js`: `priceScaleId: ''` plus `scaleMargins` on that series' price scale. For a separate volume pane, use `addSeries(HistogramSeries, opts, 1)` and then `chart.panes()[1].setHeight(px)`.

## Live 1-minute candle per trade

Rules from the typings and the upstream skill:

- Call `setData` **once** with the history relayed from the broker sites. It "replaces the dataset and can reset the visible range." Call it again only for a full replacement, such as a stock code change or a prepended history chunk. Upstream: "`setData` on every tick" is a footgun. Use `series.update(point)`.
- For each trade, compute `bucket = Math.floor(tradeEpochSeconds / 60) * 60` as a `UTCTimestamp`. Keep the current bar in a ref:
  - if `bucket` equals the current bar's time, set `high = max(high, price)`, `low = min(low, price)`, `close = price`, and `volume += lots`
  - if `bucket` is later, start a new bar with `open = high = low = close = price`
  - call `candles.update(bar)` and `volume.update({ time: bucket, value, color })`. `update` replaces when the times are equal and appends when the new time is later.
- A trade **older** than the current bar must not go through plain `update`, because the time must be at least the last bar's time. Late trades can arrive when two feeds are merged. Use `update(bar, true)` to edit an existing older bar ("slower"), or drop the trade. `update` cannot insert a minute that has no bar, so a gap needs a rebuilt array and `setData`.
- Times must be unique and ascending, and a series must use a single time format. Write `Math.floor(ms / 1000)`, never `Date.now()`.
- `timeScale.shiftVisibleRangeOnNewBar` (default `true`) keeps the view following new bars while the last bar is visible. `scrollToRealTime()` only helps for an explicit "jump to live" control.
- Per-bar colour belongs on the data point (`color`, `borderColor` and `wickColor` on candles, `color` on histogram points). Use it for up and down volume. Do not add extra series.

### WIB (Asia/Jakarta) display

Official `docs/time-zones.md`: the library "does not natively support time zones" and handles times as UTC. The page describes pre-shifting timestamps by the zone offset. The upstream skill recommends display formatters instead, because "pre-shifting timestamps changes chart semantics." No `timeScale.timezone` option exists.

Asia/Jakarta is UTC+7 all year with no DST. The DST caveats in the time-zones doc therefore do not apply. Keep data in true UTC seconds, which also matches the trade timestamps:

```ts
const wib = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false,
}) // create once: the time-zones doc warns that building a formatter is slow
const fmt = (t: Time) => (typeof t === "number" ? wib.format(new Date(t * 1000)) : String(t))

createChart(el, {
  localization: { locale: "id-ID", timeFormatter: fmt },         // crosshair label
  timeScale: { timeVisible: true, secondsVisible: false,
               tickMarkFormatter: (t, type) => fmt(t) },            // axis ticks
})
```

`tickMarkFormatter(time, tickMarkType, locale)` receives a `TickMarkType` (`Year`, `Month`, `DayOfMonth`, `Time`, `TimeWithSeconds`). Format `DayOfMonth` as a date so a day boundary does not show as `00:00`. Return `null` to use the default label. `localization.locale` defaults to `navigator.language`, and setting `id-ID` explicitly keeps the server and every client the same. Pass `null` (not `undefined`) to `applyOptions` to clear a formatter.

## Performance notes

- `update` on the last bar is the fast path. `update(_, true)` on an older bar is documented as slower. `setData` rebuilds everything and can reset the view.
- A full IDX session of 1-minute bars is roughly 330 points per stock, far below the scale where upstream suggests `enableConflation` or `precomputeConflationOnInit` (">10K points"). Leave both off, which is the default.
- Whole-market trades can arrive faster than the frame rate. One `update` per trade works, but batching to one `update` per animation frame with the latest bar costs nothing and keeps React state out of the hot path. Hold the series in refs and do not re-render React per trade.
- 5.2.1 removed the per-mouse-move dataset clone when markers are present. `autoscaleInfoProvider`, if used, runs on every layout pass, so keep it free of allocations.

## Licence and attribution

- Licence: Apache-2.0 (`LICENSE`, "Copyright 2023 TradingView, Inc.").
- README "License" section: "This license requires specifying TradingView as the product creator. You shall add the 'attribution notice' from the NOTICE file and a link to https://www.tradingview.com/ to the page of your website or mobile application that is available to your users." It adds that the `attributionLogo` chart option "will satisfy the link requirement."
- `NOTICE` (repo root; not in the npm tarball):
  ```
  TradingView Lightweight Charts™
  Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
  ```
- `LayoutOptions.attributionLogo: boolean`, default `true`. The typings say: "Using this attribution logo is sufficient for meeting this linking requirement." It is not sufficient for the NOTICE text.
- For Market Live: keep `attributionLogo: true`, and add the NOTICE line, linking tradingview.com, to the page, for example in a muted footnote under the chart. Turning the logo off is allowed only when the page already has the tradingview.com link.

## Theming from CSS tokens

- The chart draws on canvas. Colour options are plain strings that the library parses itself. The parser accepts hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `hwb()`, named colours and `transparent`. Other spaces, such as `oklch()`, `lab()` and `color(display-p3 …)`, need `layout.colorParsers`, which can only be set at creation. A `var(--semantic-up)` string will **not** work. So `CHART_COLOR` in `apps/dashboard/src/components/k/charts/colors.ts` (all `var(...)` values, meant for SVG) cannot be passed in as is.
- Resolve the tokens in the browser at mount: `getComputedStyle(el).getPropertyValue("--semantic-up").trim()`. The dashboard tokens in `apps/dashboard/src/styles.css` are all hex (`--bg-canvas #0b1421`, `--semantic-up #51dda2`, `--semantic-down #ff7987`, `--chart-volume #627f9b`, `--chart-grid #26384b`, `--text-muted #839aae`, `--border-strong #3e566b`), so the built-in parser handles them.
- Mapping that mirrors the SVG charts:
  - `layout.background {type: ColorType.Solid, color: --bg-surface or --bg-canvas}`
  - `layout.textColor: --text-muted`
  - `layout.fontFamily` set to the resolved `--font-mono` value (`"Manrope Variable", Arial, sans-serif`), `fontSize: 11`
  - `grid.{vertLines,horzLines}.color: --chart-grid`
  - `rightPriceScale.borderColor` and `timeScale.borderColor: --border-strong`
  - candles `upColor`/`borderUpColor`/`wickUpColor: --semantic-up`, and the matching `down*` options: `--semantic-down`
  - volume `--chart-volume` at `VOLUME_OPACITY` 0.65, converted to `rgba()` or `#RRGGBBAA`, because there is no separate opacity option
  - crosshair label background `--bg-elevated`
- Dark mode: `styles.css` says "Dark is the only theme", so resolving the tokens once at mount is enough. If a light theme is added later, watch the theme switch (for example a `MutationObserver` on `<html class>` or a `prefers-color-scheme` listener), resolve the tokens again and call `chart.applyOptions(...)` and `series.applyOptions(...)`. Do not recreate the chart, which the React tutorial does by putting the colours in effect dependencies. `colorSpace` and `colorParsers` cannot change after creation.

## Footguns

- Do not copy v4 snippets that use `addCandlestickSeries` or `series.setMarkers`. Use `addSeries(CandlestickSeries)` and `createSeriesMarkers(series, …)`.
- Upstream's SSR advice targets Next.js (`'use client'` plus `next/dynamic({ ssr: false })`). In Start the equivalent is `ClientOnly` with `useEffect`. A top-level import is fine here because the module does not touch the DOM when it loads (verified above).
- `subscribeCrosshairMove` gives `param.time === undefined` outside the data range, and `param.seriesData.get(series)` can be `undefined`, so check both before building a readout.
- `chart.priceScale(id)` needs an id. `series.priceScale()` does not.

## Sources

- npm registry: `npm view lightweight-charts dist-tags time` and the `lightweight-charts@5.2.1` tarball (`package.json`, `README.md`, `LICENSE`, `dist/typings.d.ts`, `dist/lightweight-charts.production.mjs`)
- https://github.com/tradingview/lightweight-charts: `NOTICE`, releases v5.2.0 and v5.2.1, `.github/skills/lightweight-charts/SKILL.md`, `website/examples/price-scales/price-and-volume.js`
- https://tradingview.github.io/lightweight-charts/docs/time-zones
- https://tradingview.github.io/lightweight-charts/tutorials/react/simple
- https://tradingview.github.io/lightweight-charts/docs/series-types
- npm `@tanstack/react-router@1.170.46`: `dist/esm/ClientOnly.d.ts`
- Local SSR check: Node 26, `import("lightweight-charts")` succeeds and `createChart` throws `document is not defined`
- Repo: `apps/dashboard/src/styles.css`, `apps/dashboard/src/components/k/charts/colors.ts`
