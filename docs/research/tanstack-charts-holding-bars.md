# What TanStack Charts can draw for Holding composition's stacked monthly columns

Research for #380 (map #379). Read 2026-11-16 against `@tanstack/charts@1.5.0` and `@tanstack/react-charts@1.5.0` (npm `latest`, both published 2026-11-07). Sources: the docs shipped in the `@tanstack/charts` tarball (`docs/`, the same files as the repo's [`docs/` at tag v1.5.0][docs]), its `dist/*.d.ts` and `dist/*.js`, and the `@tanstack/react-charts` tarball. No code from either package was run.

## Verdict

TanStack Charts can draw the Bars view. Stacked columns in a fixed order, our y domain and ticks, a band per month including empty ones, and `var(--…)` colors are all built in. Four kept behaviors need our own code on top:

- **The sticky y-axis.** Today it is a rail that stays put while the columns scroll. The chart draws its y-axis inside the same SVG, so the axis would scroll away with the columns.
- **The gap column's hover and focus.** A month with no rows has no point to hover or focus, so it needs an invisible `bandX` behind it.
- **Tooltip content.** We render it in `renderTooltipBody`, plus a text string for screen readers.
- **The legend.** We keep our own, because the library's legend has no double-click to isolate a series.

One behavior can't be kept as it is. A column is no longer a focusable `<button aria-label="October 2026">`. The chart is one focusable `role="img"` SVG. Arrow keys move between months, and a polite live region reads out the focused month. The tests that query a `button` per month have to change.

Two package facts matter before choosing an import:

- **Import path.** `@tanstack/react-charts` is now a thin compatibility package that depends on `@tanstack/charts@1.5.0`. Its README says "New applications use the React adapter from `@tanstack/charts/react`". The same `Chart` (with `renderTooltipBody` in `/tooltip`) lives at both paths. ([react-charts README][rc-readme], `@tanstack/react-charts` `package.json`)
- **Rendering.** It is not the old react-charts v3 canvas/DOM library. It is a chart grammar of marks, channels and scales, and it renders SVG by default. ([README][readme], [overview][overview])

## Package

- `@tanstack/charts` 1.5.0. MIT license, ESM, React peer `^18 || ^19` (the dashboard is on 19.2). Its runtime dependencies are granular `d3-*` modules (`d3-shape` does the stacking: `dist/stack-internal.js` imports `stack` from `d3-shape`).
- Versions: 1.0.0 shipped on 2026-10-03, then 1.1 to 1.5 within five weeks. From 1.0 on, the [stable compatibility contract][compat] applies: a breaking change needs a major release. Undocumented DOM selectors, generated keys and "exact serialized formatting" are implementation details, so tests should not assert on them.
- React entry points: `@tanstack/charts/react` (SVG), `/react/canvas`, `/react/core` (a custom renderer), and `/react/tooltip` (the same three components plus `renderTooltipBody`). ([React Chart reference][react-chart])

## 1. Stacked columns, one per month, up to ~11 series in a fixed order: built in

- `barY(rows, { x: 'month', y: 'share', color: 'series' })` draws vertical bars. A repeated `x` "stack[s] by default", with positive values going up from zero. ([bar and rect marks][bar])
- `layout: stack({ order: [...] })` takes "an explicit series list". `orderedSeries` puts the explicit keys first, then any series not listed, in first-seen order. d3's stack puts the first series in the order at the baseline, so `order[0]` sits at the bottom. This matches today's `flex-col-reverse`, where `chart.series[0]` is the bottom segment. (`dist/stack-internal.js` `orderedSeries`, `stackOffsetDivergingZeroAware`)
- The data is long rows: one row per (month, series) with its share. That is a reshape of `HoldingChart.columns[].shares[]`. Each position and series pair may appear only once, otherwise it throws ("A stack requires at most one value for each position and series"). A series missing at a month counts as zero and creates no synthetic row. (`dist/stack-internal.js`; [bar][bar] "Stacked bars")
- The docs set no limit on the number of series. 11 series × ~96 months is about 1,056 `rect` nodes in the SVG.

## 2. Our y domain `0 … axisMax` and five formatted ticks: built in

- A configured scale instance keeps its domain: `scales.y = { scale: scaleLinear().domain([0, axisMax]) }`. "Instances retain their semantic domain"; the library assigns only the pixel range. ([scales, guides and color: Fixed domains][scales])
- `axis.ticks.values` supplies exact tick candidates, and `axis.ticks.format: (value) => string` formats them. So `values: [0, .25, .5, .75, 1].map(t => t * axisMax)` with our `percentTick` gives `2.5%` and the others. `count`, `spacing` and `values` are mutually exclusive. ([scales: Axis options][scales])
- `grid: { strokeDasharray: '…', stroke: … }` draws the dashed gridlines at the same candidates. ([scales: Axis options][scales])
- `nice` defaults to `false`, so the domain stays exactly `[0, axisMax]`.

## 3. Fixed column width that overflows sideways: built in (fixed `width`); the sticky y-axis needs our code

- `Chart` takes `width` as "Fixed CSS and scene width". With a fixed `width` and `height`, the outer host gets a fixed CSS width and height, and the scene uses the same size. So the chart can be wider than its container and scroll inside our `overflow-x-auto` div. Without `width`, it fits the container width through a `ResizeObserver`. ([React Chart reference][react-chart]; [React adapter: Sizing and layout][react-adapter]; [Responsive charts][responsive])
- No option sets a pixel width per band. The band width comes out of the scale: `scaleBand<string>().domain(months).paddingInner(p).paddingOuter(q)` over the plot width ([scales and D3: bandwidth][scales-d3]; `dist/scales/band-kernel.d.ts`). To get today's 36 px columns with 8 px gaps, we set `width` to about `months × 44` plus the margins. We can make the margins predictable by locking them (`margin: { left: …, right: … }` "locks only that side"; [Responsive charts][responsive]). `maxThickness` caps a bar's painted width but cannot widen it ([bar][bar]).
- The scene is sized synchronously from `width`, so the server markup already has the final geometry. Our `useLayoutEffect` that sets `scrollLeft = scrollWidth` still works on the scroll container. The adapter renders SVG during SSR at `width` (or `initialWidth`) and adopts it after hydration. ([React adapter: SSR and hydration][react-adapter])
- **Sticky y-axis: our code.** The y-axis is drawn inside the same SVG, so it scrolls away with the columns. The documented pattern for a wide, scrolling chart is native horizontal overflow with "a fixed rail" outside the scroll region, positioned "from `onRender` with `scene.scales.y.map`" ([Interactive charts: Scroll a wide schedule][interactive]; [Interactions: Scrollable lanes][interactions]). So: set `axis: false` on y in the scrolling chart and keep `grid: true`. Then draw the tick labels in our own rail, placed with `scene.scales.y.map` and `scene.chart` from `onRender` ([framework tick labels][tick-labels]; [layout: scene coordinates][layout]).
- X tick labels: `axis.ticks.format` turns `2026-10` into `Oct 26`. Labels are "collision-thinned by default", so set `tickLabels.thin: false` to keep every month labelled. ([scales: Axis options][scales])

## 4. A month with no data as an empty, labelled column: drawing built in; hover and focus need our code

- **The empty band.** The band scale's configured domain lists every month, so a month with no rows still gets its band and its x tick label ("Fixed domains remain application semantics": [scales and D3][scales-d3]). `barY` emits nothing there.
- **The "No data" label.** A `text` mark over the gap months, with `rotate: -90`, `text: 'No data'`, and `y` at mid-domain, draws today's vertical label. `text` supports `rotate`, `fill`, `fontSize` and `anchor` as options. ([text, frame and facet marks][text])
- **Hover and focus: our code.** Focus candidates are the interaction points that marks attach to scene primitives (`dist/scene.js` `collectRenderedPoints`). A month with no bar has no point, so pointer focus and arrow keys skip it. `bandX(rows, { x: 'month' })` paints a full-height rect at each x and attaches an interaction point to it (`dist/band.js`: `interaction: { point, affinity: "x" }`). A `bandX` with `fillOpacity: 0` over the gap months (or over all months, behind the bars) gives each gap a hover and keyboard stop, and our tooltip body can say "No data: KSEI's report has no row for this month". ([bar: `bandX` and `bandY`][bar]; [focus and interaction: Interaction geometry][focus])

## 5. A tooltip we render ourselves, or a hook with the hovered or focused month: both built in

- **A React body inside the library's tooltip.** `Chart` from `@tanstack/charts/react/tooltip` takes `renderTooltipBody({ points, content, defaultBody, pinned, dismiss }) => ReactNode`. We can drop `defaultBody` and render our own `<dl>` with swatches, rows sorted largest first, and "Share of …". ([React Chart: Tooltip body][react-chart]; [Tooltips and focus: Rich and nested tooltips][tooltips])
  - `focus: 'group-x'` returns "one point per group sharing the semantic x value", so `points` holds the month's shown series. ([focus: Focus modes][focus])
  - `tooltip.sort` accepts a typed comparator. Sorting by `point.datum.share` gives largest first. (We read the share from the datum, because `point.yValue` on a bar is its value endpoint: [bar][bar].)
  - Placement: `anchor: 'group-center'` and `placement: ['right', 'left', …]` (today's `side="right"`). `portal` (from `@tanstack/charts/tooltip/portal`) lifts the tooltip into the top layer, so our `overflow-x-auto` scroll container doesn't clip it. ([tooltips: Escaping clipped containers][tooltips])
  - Clicking or pressing Enter pins the tooltip by default. `sticky: false` turns that off and keeps today's hover-only tooltip. ([focus: Tooltips][focus])
  - Styling: the shell takes `className` and `--ts-chart-tooltip-*` variables (background, border, radius, shadow, padding, font), so it can match `KTooltip`'s look. ([focus: Tooltips][focus])
- **A callback instead, so `KTooltip` shows it.** `onFocusChange(point | null)` and `onFocusGroupChange(points)` report pointer and keyboard focus with `datum`, `xValue` and the pixel `x` and `y`. They run "only when the primary focus key changes". ([React Chart: Callbacks][react-chart]; [focus: Callbacks][focus]) `KTooltip` wraps a trigger element (`TooltipTrigger render={children}`, `apps/dashboard/src/components/k/tooltip.tsx`). Driving it means a controlled `open` and an invisible trigger that we position at the point's pixel coordinates, which is our code. The built-in body route needs neither.
- **Screen-reader text: our code.** The React body is `inert` while the tooltip is transient, so assistive technology does not read it. The tooltip element's `aria-label` comes from the definition's `content`, `formatGroup` or `format` result (`dist/tooltip.js` `setTooltipContentAccessibility`, `configureTooltipSemantics`). So we also write a `formatGroup` that returns the same rows as text.

## 6. Hiding a series without remounting, with the axis rescaling: built in (with our legend)

- A new definition identity updates the mounted chart in place. The adapter keeps one runtime and host per mounted component and calls `host.update` on later commits. "A new definition identity rebuilds the scene", and the surface is not rebuilt through React. (`@tanstack/react-charts` `dist/RendererChart.js`: `adapter.update(hostOptions)`, then `mount` only once; [React adapter: Render lifecycle][react-adapter])
- So our legend removes the hidden series' rows from the data. A `useMemo` builds the definition from those rows and `scaleLinear().domain([0, axisMax])`, where `axisMax` comes from `holdingChart`. The stack is computed again without those series, the y-axis takes the new domain, and the DOM node stays. That keeps the scroll position, as today's `Decision:` about not remounting requires. Animating the change is opt-in through `svgAnimation`. ([dynamic data and animation][dynamic])
- **Built-in legend: doesn't fit.** `interactiveColorLegend` toggles series with native `aria-pressed` buttons. It has no double-click to isolate a series, and hidden series "remain in categorical and positional domains", so the axis would not zoom on its own. ([scales: Interactive categorical legend][scales]) Our `Legend` component stays, as #379 already expects.

## 7. Colors from CSS custom properties, light and dark: built in (SVG)

- The SVG renderer writes `fill` as a presentation attribute with the string we pass (`dist/svg-renderer.js` `renderStyle`). Its own default palette is `var(--ts-chart-1, #2563eb)` and so on (`dist/scene.js`). So `var(--origin-local)` is a supported paint. It resolves in the page's CSS, so a light or dark switch repaints with no rebuild. ([Themes and styling: Palette tokens][themes])
- We pass the colors as `color: { domain: seriesKeys, range: seriesKeys.map(k => SERIES_COLOR[k]) }` (the built-in ordinal scale) or `scaleOrdinal(keys, colors)`. The color range "remains the range you configured". ([scales: Color][scales]; [scales and D3: Color scales][scales-d3])
- Axis text and gridlines default to `currentColor`, so the container's `color` sets them (for example `text-muted-foreground`). `theme` can override foreground, muted, grid and background. ([themes][themes])
- The tooltip swatch is painted with the point's resolved color string, so a `var()` works there too.
- The canvas renderer would also resolve CSS custom properties against computed styles and repaint after a class, `data-theme` or color-scheme change ([themes: Canvas styling][themes]). It is not needed here.

## 8. Keyboard and screen readers: partly built in; one focusable button per column can't be kept

- **What the library gives.** The SVG is a single tab stop: `role="img"`, `aria-roledescription="chart"`, `aria-label` from the required `ariaLabel` prop, and `tabindex="0"` (`dist/svg-renderer.js`). Focusing it selects the first point. Arrow keys move through points sorted by pixel x, and with `group-x` there is "one representative per semantic x value", so arrows step one month at a time. Home and End jump to the ends, Enter or Space pins the tooltip, and Escape dismisses it. ([focus: Default behavior, Focus modes][focus]; [tooltips: Keyboard behavior][tooltips])
- **How the focused month is announced.** The tooltip has `role="status"` and `aria-live="polite"`. Its `aria-label` is the `content` or `formatGroup` text, see 5. ([accessibility: Tooltips are supplemental][a11y]; `dist/tooltip.js`) The docs do not test how screen readers announce it, and I did not test it either.
- **What can't be kept.** No column is its own focusable element with its own accessible name. Children of a `role="img"` SVG are not exposed, and the focus ring and bands are `aria-hidden` (`dist/svg-renderer.js`; [focus: Built-in focus ring][focus]). So `getByRole('button', { name: 'October 2026' })` in `holding-composition.test.tsx` and in `apps/e2e/tests/stocks.spec.ts` stops matching. The library's own guidance is to keep exact values in HTML next to the chart, such as a linked table ([accessibility: Linked table pattern][a11y]). Our Table view already does that.
- **Focus indicator.** The built-in ring is a dot at the focused point (`focusRing`, radius 5). The column-box look of today's `kFocus` needs `focusRing: false` plus `whenFocused(bandX(…), { match: 'x' })` with a stroke. That is composition, not new code. ([tooltips: Angular focus][tooltips]; [bar: `bandX`][bar])

## 9. SVG, canvas or DOM, and what it means for 1–8

- The default `Chart` renders **SVG**: one `<svg>` with a keyed node per bar, rule and label, inside `.ts-chart-host > .ts-chart-surface`. `/react/canvas` swaps in a five-layer canvas, and single marks can opt into canvas. Tooltips, the interactive legend and the brush and zoom handles are **HTML** overlays the DOM host owns. ([React adapter: Default server output, Sizing and layout][react-adapter]; [rendering and export][render])
- What SVG means for this chart:
  - **1, 4:** every segment and the gap label are real DOM nodes, about a thousand rects at most. The docs suggest canvas only for "a measured paint-heavy mark" ([llms.txt][llms] authoring rules), so SVG is enough here.
  - **3:** SSR emits the full SVG at the fixed `width`, so the scroll width is known before hydration. No `ClientOnly` is needed, unlike Lightweight Charts.
  - **5:** the tooltip is HTML, so a React body and Tailwind classes work. Inside `overflow-x-auto` it needs `portal`.
  - **7:** `var()` paint resolves in the page's CSS.
  - **8:** the SVG stays one `role="img"` surface, so columns are not separate accessible elements.
- **Tests.** The scene is in the DOM, but undocumented selectors and generated keys are not part of the [compatibility contract][compat]. The [testing guide][testing] says to "test the scene first" with the DOM-free `createChartScene(definition, …)` (domains, ticks, `scene.points`, scene nodes). It also says to mount the DOM host in "a real or sufficiently complete DOM" for focus, keyboard, tooltip and responsive behavior. The DOM host relies on `ResizeObserver` and measures text in the DOM. I did not check whether it runs in the dashboard's component-test DOM environment.

## Confidence

- High: 1, 2, 5, 6 and 7. Each is a documented option, and I checked it against the shipped `.d.ts` and `dist` source.
- Medium: 3 and 4. Exact 36 px bands depend on margin arithmetic, and the gap's focus stop depends on the `bandX` workaround. Neither was rendered, so a prototype should confirm both.
- Unverified: how a screen reader actually announces the live-region `aria-label` (8), and whether the DOM host runs in the dashboard's test environment (9).

[docs]: https://github.com/TanStack/charts/tree/v1.5.0/docs
[readme]: https://github.com/TanStack/charts/blob/v1.5.0/packages/charts-core/README.md
[rc-readme]: https://github.com/TanStack/charts/blob/v1.5.0/packages/react-charts/README.md
[overview]: https://github.com/TanStack/charts/blob/v1.5.0/docs/overview.md
[compat]: https://github.com/TanStack/charts/blob/v1.5.0/docs/compatibility.md
[llms]: https://github.com/TanStack/charts/blob/v1.5.0/packages/charts-core/llms.txt
[bar]: https://github.com/TanStack/charts/blob/v1.5.0/docs/reference/marks/bar-and-rect.md
[text]: https://github.com/TanStack/charts/blob/v1.5.0/docs/reference/marks/text-frame-and-facet.md
[scales]: https://github.com/TanStack/charts/blob/v1.5.0/docs/reference/scales-guides-and-color.md
[scales-d3]: https://github.com/TanStack/charts/blob/v1.5.0/docs/concepts/scales-and-d3.md
[layout]: https://github.com/TanStack/charts/blob/v1.5.0/docs/concepts/layout-axes-and-coordinates.md
[responsive]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/responsive-charts.md
[react-chart]: https://github.com/TanStack/charts/blob/v1.5.0/docs/framework/react/reference/chart.md
[react-adapter]: https://github.com/TanStack/charts/blob/v1.5.0/docs/framework/react/adapter.md
[tooltips]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/tooltips-and-focus.md
[focus]: https://github.com/TanStack/charts/blob/v1.5.0/docs/reference/focus-and-interaction.md
[a11y]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/accessibility.md
[themes]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/themes-and-styling.md
[interactive]: https://github.com/TanStack/charts/blob/v1.5.0/docs/examples/interactive-charts.md
[interactions]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/interactions-and-selections.md
[tick-labels]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/framework-tick-labels.md
[dynamic]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/dynamic-data-and-animation.md
[render]: https://github.com/TanStack/charts/blob/v1.5.0/docs/reference/rendering-and-export.md
[testing]: https://github.com/TanStack/charts/blob/v1.5.0/docs/guides/testing-and-debugging.md
