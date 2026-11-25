# Research

Findings from research tickets, one file per question. Each records what was true when it was written; check the code and the vendored references before you act on one.

## Broker data

- [How Stockbit delivers running trades, intraday candles and stock codes](stockbit-live-data.md)
- [How Ajaib's web app gets running trades, 1-minute candles and stock codes](ajaib-live-data.md)
- [Which live price and order book channels Stockbit and Ajaib offer](live-price-channels.md)
- [How Stockbit's and Ajaib's websockets ping, pong and time out](broker-websocket-heartbeats.md)
- [How many frames a second each broker socket sends the relay](broker-frame-rates.md)
- [How many codes' order books the relay can keep subscribed, and how fast they update](order-book-subscription-capacity.md)
- [Measured order book update rates and viewer socket bytes](order-book-rates-measured/README.md)
- [Whether the REST running-trade tapes can fetch a trade-number range](rest-tape-backfill.md)
- [Stockbit's post-close buyer and seller broker codes](stockbit-post-close-broker-codes.md)
- [Ajaib's post-close buyer and seller broker codes, and paging a whole day](ajaib-post-close-broker-codes.md)
- [How a day's broker codes join its tape, and how big one day's per-broker totals are](broker-totals-per-day.md)
- [Which post-close route gives each trade's buy and sell order numbers with its trade number](order-number-routes.md)
- [Order-number captures from Stockbit and Ajaib, 2026-11-20](order-number-captures/README.md)

## Order book readings

- [How to detect absorption, reload and walls from aggregated price levels and the tape](book-absorption-reload-walls.md)
- [Book event thresholds tuned on a recorded day](book-event-thresholds.md)
- [Order flow event thresholds tuned on recorded days](order-flow-event-thresholds.md)

## IDX

- [Where company logos can come from, and whether Kumora may show them](idx-company-logos.md)
- [Where the IDX trading schedule and holiday list come from](idx-trading-schedule.md)
- [Where the Special Monitoring Board list, tick sizes and price limits come from](idx-board-ticks-limits.md)
- [How IDX serves the Data Kepemilikan Saham listing and its files](idx-kepemilikan-listing.md)
- [Cloudflare Workflows for a shareholding archive run](cloudflare-workflows-shareholding-archive.md)
- [Replacing a month's classification holdings in D1 from a Worker](d1-month-replace.md)
- [Parsing an IDX classification xlsx inside the dashboard Worker](idx-classification-xlsx-parse.md)
- [What IDX's investor-type report holds, and what its ≥5% band means](idx-investor-type-report.md)
- [Where the IDX-IC sector of every stock code comes from](idx-sector-classification.md)
- [What IDX's above-1% report holds, and how stable its holder names are](idx-above-1-report.md)

## KSEI

- [How KSEI serves the Statistik Efek and Kepemilikan Efek listings and their files](ksei-statistik-kepemilikan-listing.md)
- [KSEI's Kepemilikan Efek file compared with IDX's investor type and classification reports](ksei-holdings-vs-idx.md)

## Relay extension

- [Capturing a page's WebSocket frames in an MV3 extension and relaying them](mv3-websocket-relay.md)
- [Where a frame's time goes inside the relay](relay-event-queue-clamp/README.md)

## Durable Objects

- [What a Durable Object can do per second for a hot ingest stream](durable-object-ingest-limits.md)
- [Durable Object write volume and cost when every order book frame is stored](durable-object-cost.md)
- [How the Market Live websocket upgrade checks a Better Auth session](durable-object-session-gate.md)
- [How Cloudflare counts Durable Object SQL rows and storage, and where to read them by stage and day](do-sql-billing.md)
- [What re-asks a sealed day object all night, and what drives the walk bursts](sealed-day-poller.md)
- [Answering each recorded-day view straight from R2](cold-day-r2-layout.md)
- [Where a trading day's 1.3–1.8 GB of storage goes, by table](day-storage-by-table.md)
- [Which Durable Object SQL statements read and write the most rows](do-sql-audit.md)

## Charts

- [Lightweight Charts in a TanStack Start page on Workers](lightweight-charts-start.md)
- [Sweep bubbles, a book heatmap and footprint cells in Lightweight Charts](lightweight-charts-order-flow.md)
- [What TanStack Charts can draw for Holding composition's stacked monthly columns](tanstack-charts-holding-bars.md)
- [Whether TanStack Charts fits the dashboard's SSR, tests and bundle](tanstack-charts-runtime-fit.md)

## App stack

- [Alchemy and a TanStack Start app on Cloudflare](alchemy-tanstack-start.md)
- [TanStack Start prerendering under Alchemy's Vite build](tanstack-prerender-alchemy.md)
- [Effect version and runtime in TanStack Start on Workers](effect-version-runtime.md)
- [@effect/atom-react under TanStack Start SSR](atom-react-ssr.md)
- [Better Auth on the dashboard Worker with D1](better-auth-workers-d1.md)
- [Which email sender delivers verification and reset mail from a Worker](worker-email-sender.md)

## Deploy

- [Alchemy: where state lives, and how stages and PR previews work](alchemy-state-and-stages.md)
- [Can Workers Builds run an Alchemy deploy for each stage?](workers-builds-alchemy.md)
- [The deploy token swap under in-process Alchemist](alchemy-inprocess-token-swap.md)
- [How Infisical secrets reach an Alchemy deploy and the Worker runtime](infisical-alchemy-secrets.md)
- [Effect v4 platform APIs for scripts and deploy](effect-platform-scripts.md)

## CI and tooling

- [Where CI time goes](ci-timings.md)
- [Turbo remote caches for GitHub Actions](turbo-remote-cache.md)
- [Playwright workers and sharding with `apps/e2e`'s project dependencies](playwright-sharding.md)
- [Where to host a local e2e video so it plays inline on a GitHub PR](pr-video-hosting.md)
- [DOM test environment without splitting alchemy](dom-test-env-peers.md)
- [Which Effect-migration bans oxlint 1.90 can express](oxlint-effect-bans.md)

## Hostinger box

- [A recorded day replayed into DuckDB on the Hostinger box](duckdb-box-replay.md)
- [Can embedded DuckDB 2.0 in a Node service take the trading-day object's load on 2 vCPU and 8 GB?](duckdb-embedded-ingest-load.md)
- [What Quack in DuckDB 2.0 offers a Cloudflare Worker reading a database on the box](duckdb-quack-workers.md)
- [How the relay's ingest socket and the Worker's reads reach the Hostinger box](hostinger-box-network-path.md)

## Market Live

- [Where every code's top-1% sweep cutoff can come from for the whole tape](whole-tape-sweep-cutoffs.md)
- [Prototype: how an order-run piece shows in the sweep log and as bubbles](order-run-sweep-log-prototype/README.md)
- [What grouping sweeps costs at the open](sweep-grouping-cost/README.md)
