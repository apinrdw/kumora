# Research

Findings from research tickets, one file per question. Each records what was true when it was written; check the code and the vendored references before you act on one.

## Broker data

- [How Stockbit delivers running trades, intraday candles and stock codes](stockbit-live-data.md)
- [How Ajaib's web app gets running trades, 1-minute candles and stock codes](ajaib-live-data.md)
- [Which live price and order book channels Stockbit and Ajaib offer](live-price-channels.md)
- [How Stockbit's and Ajaib's websockets ping, pong and time out](broker-websocket-heartbeats.md)
- [How many frames a second each broker socket sends the relay](broker-frame-rates.md)
- [Whether the REST running-trade tapes can fetch a trade-number range](rest-tape-backfill.md)
- [Stockbit's post-close buyer and seller broker codes](stockbit-post-close-broker-codes.md)
- [Ajaib's post-close buyer and seller broker codes, and paging a whole day](ajaib-post-close-broker-codes.md)

## IDX

- [Where company logos can come from, and whether Kumora may show them](idx-company-logos.md)
- [Where the IDX trading schedule and holiday list come from](idx-trading-schedule.md)
- [How IDX serves the Data Kepemilikan Saham listing and its files](idx-kepemilikan-listing.md)
- [Cloudflare Workflows for a shareholding archive run](cloudflare-workflows-shareholding-archive.md)

## KSEI

- [How KSEI serves the Statistik Efek and Kepemilikan Efek listings and their files](ksei-statistik-kepemilikan-listing.md)

## Relay extension

- [Capturing a page's WebSocket frames in an MV3 extension and relaying them](mv3-websocket-relay.md)
- [Where a frame's time goes inside the relay](relay-event-queue-clamp/README.md)

## Durable Objects

- [What a Durable Object can do per second for a hot ingest stream](durable-object-ingest-limits.md)
- [Durable Object write volume and cost when every order book frame is stored](durable-object-cost.md)
- [How the Market Live websocket upgrade checks a Better Auth session](durable-object-session-gate.md)

## Charts

- [Lightweight Charts in a TanStack Start page on Workers](lightweight-charts-start.md)
- [Sweep bubbles, a book heatmap and footprint cells in Lightweight Charts](lightweight-charts-order-flow.md)

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
