# Whether TanStack Charts fits the dashboard's SSR, tests and bundle

Research for #381 (map #379). Read and run 2026-11-16 against `@tanstack/react-charts@1.5.0` and `@tanstack/charts@1.5.0`.

## Verdict

It fits. Both packages install beside React 19.3.0 with no new peer warnings. The default SVG `Chart` server-renders the complete chart, in Node and in `workerd`, and hydrates with no mismatch. It needs no client-only chunk. It mounts under the dashboard's happy-dom tests with no shims. On the stock page, a stacked bar chart with a tooltip adds 40.7 kB gzip. The same chart in recharts 3.8.0 adds 98.5 kB gzip. The license is MIT, and releases come several times a week. The project is 3.5 months old, and one author wrote most of its commits.

`@tanstack/react-charts` is now a compatibility wrapper. Its README says: "This compatibility package remains supported for existing applications. New applications use the React adapter from `@tanstack/charts/react`." Mark and scale builders (`defineChart`, `barY`, `scaleBand`) come only from `@tanstack/charts`. The wrapper's root exports only `Chart` and types. A new chart therefore depends on `@tanstack/charts` directly, and the wrapper adds nothing.

## 1. Install and peers

Run: `pnpm --filter dashboard add @tanstack/react-charts@1.5.0`, then `@tanstack/charts@1.5.0`, then a full `pnpm install`. Each run passed pnpm's supply-chain check. 1.5.0 was published 2026-11-07, which clears pnpm 11's default minimum release age.

- `@tanstack/react-charts@1.5.0` peers: `react` and `react-dom` `^18.0.0 || ^19.0.0`. Its only dependency is `@tanstack/charts` at exactly `1.5.0` (`npm view @tanstack/react-charts@1.5.0`).
- `@tanstack/charts@1.5.0` lists peers for every framework it adapts: React, Vue, Svelte, Solid, Angular, Lit, Preact, Alpine, Octane and React Native. `peerDependenciesMeta` marks all of them optional, so pnpm installs none of them (`npm view @tanstack/charts@1.5.0 peerDependenciesMeta`).
- Both packages resolved against the workspace's `react@19.3.0` / `react-dom@19.3.0`. The lockfile gained 29 packages: the two TanStack packages, d3 modules (`d3-array`, `d3-shape`, `d3-zoom`, `d3-geo`, `d3-sankey` and others) and their `@types`. `d3-sankey@0.12.3` pulls older `d3-array@2` and `d3-shape@1` alongside the v3 copies. These copies only add install size. The stock page bundle measured below never imports them.
- `pnpm peers check` reported only `capnp-es@0.0.16` wanting TypeScript `^5.7.3 || ^6.0.0`, which the lockfile already had before the add. TanStack Charts adds no peer issue.
- The `effect` and `alchemy` catalog pins did not change.
- Both `tsc --noEmit` and `tsc --noEmit -p tests` (TypeScript 7.0.2) passed with a typed stacked bar chart in `apps/dashboard/src`.

## 2. Server rendering under TanStack Start on Workers

The default React `Chart` server-renders. It does not need a client-only chunk like `live-chart.tsx`'s `lazy(() => import("./chart-canvas"))`.

The source shows why. `RendererChart.js` in `@tanstack/react-charts` calls `adapter.prerender()` during render when `useSyncExternalStore`'s server snapshot is `true`. It puts that markup in the surface with `dangerouslySetInnerHTML`. On the server it uses `useEffect` instead of `useLayoutEffect`, so `document` is never touched. The React Adapter doc (`docs/framework/react/adapter.md` in the `@tanstack/charts` tarball) states: "The default SVG entry emits ... the complete accessible shared SVG at `initialWidth`. ... There is no placeholder-only server mode." The 1.0 compatibility contract (`docs/compatibility.md`) adds: "Server-side scene compilation and SVG serialization do not require browser globals." The `'use client'` banner at the top of each entry marks a React Server Component boundary. It does not turn off server rendering. TanStack Start does not use that boundary here.

Runs, with a stacked `barY(rows, { x: "month", y: "pct", color: "origin" })` and a band x scale, `height={280}`:

- **Node, `react-dom/server` `renderToString`**, in a Vitest file with `@vitest-environment node` (`typeof document === "undefined"` asserted). The output was 5,501 characters: `.ts-chart-host` > `.ts-chart-surface` > `<svg class="ts-chart" viewBox="0 0 640 280" role="img" aria-label=...>` with grid lines, axes and 6 `<rect>` bars.
- **workerd**: the component plus `react-dom/server`'s `renderToReadableStream`, bundled with esbuild `--conditions=workerd,worker,browser`. It ran in `workerd@1.20261026.1` (the workspace's copy) with `compatibilityDate = "2026-10-01"` and `nodejs_compat`, as in `packages/deploy/src/stack.ts`. The response held the same 5,501-character markup with 6 `<rect>` bars, and nothing was logged. `mark.js` reads `process.env.NODE_ENV` behind a `typeof process === "undefined"` guard, so the code does not depend on `nodejs_compat`.
- **Hydration**: under happy-dom, that `renderToString` markup was put into a container and then hydrated with `hydrateRoot`. React reported 0 `onRecoverableError` calls and 0 `console.error` calls, and 6 bars remained after hydration.

This run did not test a full TanStack Start route through `alchemy dev`. The app's server build needs Alchemy's Cloudflare plugin to resolve `cloudflare:workers`, so it fails under a plain `vite build`. That failure happens without the chart too. The three runs above cover each layer that Start's SSR uses, which are React's stream renderer on workerd and client hydration.

Two server-render details to plan for:

- The server has no container to measure, so the SVG uses `initialWidth`, which defaults to 640. The SVG is `width="100%"` with that `viewBox`, so it stretches to the card width until the client host measures the card. The host then relays the chart out at the real width, on an animation frame (`docs/reference/dom-host.md`, "Responsive sizing"). A fixed `height` keeps the vertical size stable. Set `initialWidth` near the card's usual width to reduce that relayout.
- A definition holds functions and scale instances. Build it on the client side of the component tree (module scope or `useMemo`), and pass only row data from the loader (React Adapter doc, "Next.js App Router"). This matches how the stock page already passes `page.series` into `HoldingComposition`.

## 3. Vitest under the dashboard's DOM setup

The dashboard's DOM tests use **happy-dom 21.0.4**, not jsdom. `holding-composition.test.tsx` starts with `// @vitest-environment happy-dom`, and `happy-dom` is the dashboard devDependency. A throwaway test beside it mounted the chart with `createRoot` and `act`, the same way that file does. It found the SVG and 6 bars, dispatched a `pointermove`, unmounted, and caught no errors. **No shims were needed.**

What happy-dom 21.0.4 provides, and what the chart does with it:

| API                        | happy-dom                                             | Chart behaviour                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResizeObserver`           | present                                               | The host observes the container. happy-dom does no layout, so the width reads 0. The host ignores zero sizes and keeps `initialWidth` (`viewBox="0 0 640 280"` in the test).                                   |
| `getBoundingClientRect`    | present, returns zeros                                | Same as above. Tests should assert structure and data, not pixel positions.                                                                                                                                    |
| `CanvasRenderingContext2D` | `undefined`; `canvas.getContext("2d")` returns `null` | `dom-text.js` makes a canvas measurer only when `view.CanvasRenderingContext2D` exists. Otherwise it uses `estimateSceneText`, the same estimator the server uses. No canvas mock is needed for the SVG chart. |
| `document.fonts`           | `undefined`                                           | The `loadingdone` relayout is skipped, with no error.                                                                                                                                                          |
| `requestAnimationFrame`    | present                                               | Responsive relayouts run normally.                                                                                                                                                                             |

The Canvas entry (`@tanstack/react-charts/canvas`) is different. The library's testing guide (`docs/guides/testing-and-debugging.md`) says to use "a Canvas 2D mock for draw-call and device-pixel-ratio assertions" there. For logic that does not need a DOM, it recommends `createChartScene(definition, { width, height })`, which returns a deterministic scene that tests can assert against.

## 4. Client bundle on the stock page

Method: `vite build` in `apps/dashboard`. The client environment builds; the server build then fails on `cloudflare:workers`, as it does at baseline. Every `dist/client/assets/*.js` was gzipped at level 9 and summed. The experiment rendered one stacked bar chart (three months × two origins, grid, axes) at the top of the `/stocks/$code` route component. Vite's own gzip figure for the route chunk is in brackets.

| Build                                                                                                             | `stocks._code` chunk gzip | Added to the client total (gzip) |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------- |
| Baseline (`staging` at `81fea64e57`)                                                                              | 5.67 kB [5.70 kB]         | —                                |
| TanStack, `barY` + `tooltip`                                                                                      | 46.33 kB [46.80 kB]       | **+40.7 kB**                     |
| TanStack, `barY` without `tooltip`                                                                                | [42.50 kB]                | +36.3 kB                         |
| recharts 3.8.0, `BarChart` + 2 stacked `Bar` + `XAxis`/`YAxis`/`CartesianGrid`/`Tooltip` in `ResponsiveContainer` | 104.20 kB [105.27 kB]     | **+98.5 kB**                     |

All of the added code went into the route chunk. No shared chunk changed by more than 15 bytes. React was already in the shared chunks, so both figures leave React out.

These numbers match the library's own comparison (`docs/comparison.md`, baseline 2026-10-14). It lists TanStack Charts at 43.21–49.50 kB gzip for a cold page, and recharts at 97.24–112.60 kB gzip with React external.

Removing recharts saves nothing in today's client bundle. Only `src/components/k/charts/{price,net-flow}-chart.tsx` and `packages/ui/src/components/chart.tsx` import it, no route reaches them, and the baseline build contains no recharts code. The comparison that matters: a chart that would cost about 98 kB gzip in recharts costs about 41 kB in TanStack Charts.

The package is `sideEffects: false` and split by subpath. Canvas, motion, polar, geo and d3-backed scales enter the bundle only when imported (`docs/guides/bundle-size-and-performance.md`). Importing `@tanstack/charts/scales/band` and `/scales/linear` uses the compact scales, which have "no production D3 dependency".

## 5. License, releases and maintenance (as of 2026-11-16)

- **License**: MIT for both packages (npm `license` field, `LICENSE` in each tarball, GitHub `TanStack/charts` license `MIT`).
- **Age**: the GitHub repository was created 2026-07-28. `@tanstack/react-charts@0.0.0` was published 2026-07-29. The older unscoped `react-charts` package, by the same author, last changed in 2023 at `2.0.0-beta.7`. This is a new codebase that reuses the name.
- **Cadence** (npm `time`, GitHub releases): 41 versions in 3.5 months. 0.x releases came almost daily from 2026-07-29 to 2026-09-10. 1.0.0 shipped 2026-10-03 and 1.1.0 on 2026-10-09. 1.2.0, 1.2.1, 1.3.0, 1.4.0 and 1.5.0 shipped between 2026-11-01 and 2026-11-07. All packages share one version number and release together. Each GitHub release lists its changesets. 1.5.0 added tooltip show and hide delays and fixed one scene-subscriber bug.
- **Stability contract**: from 1.0, `docs/compatibility.md` applies. Patch releases fix defects. Minor releases add compatible features. Removing or renaming an API, or changing a documented default, needs a major release. Deprecated APIs stay supported through the current major. "SSR adoption" is named as part of the compatibility contract.
- **Activity**: the last push to `main` was 2026-11-13. There were 60 commits in the 30 days before 2026-11-16. GitHub showed 34 open issues and 15 open PRs.
- **Bus factor**: of the top contributors listed by the GitHub API, `tannerlinsley` has 461 commits, a release bot 39, and the next person 11. Three people can publish on npm: `tannerlinsley`, `alemtuzlak` and `kevinvandy`. The project depends on one maintainer and has 3.5 months of history. Pin an exact version and test each upgrade.

## Sources

- npm registry: `npm view @tanstack/react-charts`, `npm view @tanstack/charts@1.5.0` (dependencies, peers, `peerDependenciesMeta`, exports, `time`, maintainers), `npm view react-charts`.
- Tarballs `@tanstack/react-charts-1.5.0.tgz` (`README.md`, `dist/RendererChart.js`, `dist/Chart.js`, `dist/index.d.ts`) and `@tanstack/charts-1.5.0.tgz` (`docs/framework/react/adapter.md`, `docs/reference/dom-host.md`, `docs/guides/testing-and-debugging.md`, `docs/guides/bundle-size-and-performance.md`, `docs/comparison.md`, `docs/compatibility.md`, `docs/stability.md`, `dist/dom-text.js`, `dist/mark.js`).
- GitHub API for `TanStack/charts`: repository metadata, releases (v1.5.0 notes), contributors, commit count since 2026-10-16, open issue and PR search.
- Runs in a throwaway worktree on branch `research/tanstack-charts-runtime-fit`: `pnpm add` and `pnpm peers check`, `tsc`, Vitest (node and happy-dom), workerd, and four `vite build` client bundles. None of these changes were committed.
