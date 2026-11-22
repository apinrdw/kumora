# PROTOTYPE: Which Decision: comments clear the ADR bar?

Throwaway, for the ticket "Which Decision: comments clear the ADR bar?" (apinrdw/kumora#636). Never merged.

The sample has 40 of the 672 `Decision:` tag lines outside `docs/` and `repos/`. It is stratified by context and drawn at random, with a fixed seed. The bar comes from `/domain-modeling`: **R** hard to reverse, **S** surprising without context, **T** the result of a real trade-off. An ADR needs all three.

| # | Site | Gist | R | S | T | Call | Shared ADR |
|---|------|------|---|---|---|------|------------|
| 1 | apps/dashboard/src/routes/_app/admin/ksei.tsx:51 | KSEI page column layout at xl and below | – | ✓ | ✓ | comment | |
| 2 | apps/dashboard/src/server/market-live/day-index.ts:17 | Day strip cached until a minute after 17:00 WIB | – | ✓ | ✓ | comment | |
| 3 | apps/dashboard/src/server/special-board/sync.ts:15 | Read the board from SpecialNotation, not GetCompanyProfiles | – | ✓ | ✓ | comment | |
| 4 | apps/dashboard/src/server/market-live/sweep-alerts.ts:93 | A ranked sweep is known by its trades, not a number range | – | ✓ | ✓ | comment | |
| 5 | apps/dashboard/src/components/market-live/tape-list.tsx:162 | Tape columns fit whole figures, so the tape scrolls sideways | – | ✓ | ✓ | comment | |
| 6 | apps/dashboard/src/lib/broker-inventory.ts:67 | A Custom range is at most 2 years | – | – | ✓ | comment | |
| 7 | apps/dashboard/src/server/market-live/day-index-object.ts:16 | Durable Objects are plain classes; only the bridge imports `cloudflare:workers` | ✓ | ✓ | ✓ | **ADR** | A: Only the bridge reaches `cloudflare:workers` |
| 8 | apps/dashboard/src/server/holdings/month-replace.ts:54 | A parse holds its month as JSON text, not arrays (memory) | – | ✓ | ✓ | comment | |
| 9 | apps/dashboard/src/routes/_app/market-live.tsx:386 | The watchlist's Day state store starts empty on the server | – | ✓ | – | comment | |
| 10 | apps/dashboard/src/server/market-live/cold-books.ts:22 | Read a day's worth of book index in one range, no count read | – | ✓ | ✓ | comment | |
| 11 | apps/dashboard/tests/server/holdings/bounded-heap.ts:5 | Parsing any report takes at most 48 MiB of the Worker's 128 | ✓ | ✓ | ✓ | **ADR** | B: Report parsing fits a 48 MiB heap budget |
| 12 | apps/dashboard/tests/server/market-live/bubbles.test.ts:808 | The bubbles cost check reads size and build time off a test line | – | ✓ | – | comment | |
| 13 | apps/dashboard/src/server/stage-crons.ts:40 | Logo and Special Board crons run on Production only | ✓ | ✓ | ✓ | **ADR** | C: Scheduled crons run on Production only |
| 14 | apps/dashboard/src/components/market-live/chart-canvas.tsx:438 | A double click counts as a click (Lightweight Charts quirk) | – | ✓ | – | comment | |
| 15 | apps/dashboard/src/server/market-live/broker-codes.ts:188 | A day builds with at most 0.1% of trade numbers missing | – | ✓ | ✓ | comment | |
| 16 | apps/dashboard/src/server/market-live/cold-tape.ts:179 | An isolate keeps the tape indexes of the last 8 cold days | – | – | ✓ | comment | |
| 17 | apps/dashboard/tests/components/market-live/watchlist-bench.test.tsx:32 | The store path may cost twice the plain baseline | – | – | ✓ | comment | |
| 18 | apps/dashboard/alchemy.run.ts:212 | Production's buckets survive a stack destroy; other stages' are emptied | ✓ | ✓ | ✓ | **ADR** | D: Only Production keeps its data through a destroy |
| 19 | apps/dashboard/src/server/stage-crons.ts:18 | The archive cron runs on Production only, since dev fires crons | ✓ | ✓ | ✓ | **ADR** | C |
| 20 | apps/dashboard/src/components/market-live/price-axis.ts:113 | Use the series' price format, not the chart-wide formatter | – | ✓ | – | comment | |
| 21 | apps/extension/src/worker/broker-codes/extra-target.ts:113 | A 401 or 426 stops the extra target until its settings change | ✓ | ✓ | ✓ | **ADR** | E: 401 refuses the token, 426 means reload the extension |
| 22 | apps/extension/src/worker/service-worker.ts:504 | Walk order: Ajaib tape, then Done Details, then Stockbit | ✓ | ✓ | ✓ | **ADR** | F: Which feed fills which part of a recorded day |
| 23 | apps/extension/src/worker/broker-codes/status.ts:53 | 401 refuses the token; 426 or a foreign 200 means the dashboard moved on | ✓ | ✓ | ✓ | **ADR** | E |
| 24 | apps/extension/src/worker/service-worker.ts:648 | Every fiber yields through a MessageChannel scheduler | – | ✓ | ✓ | comment | |
| 25 | apps/extension/src/worker/broker-codes/production-target.ts:26 | Production's 401 or 426 stops it too, and shows over the socket's state | ✓ | ✓ | ✓ | **ADR** | E |
| 26 | apps/extension/src/worker/broker.ts:377 | A socket that never framed waits for the next tick to reopen | – | ✓ | ✓ | comment | |
| 27 | packages/relay/src/code-list.ts:37 | A code's kind comes from its suffix alone | – | ✓ | – | comment | |
| 28 | packages/relay/src/ticks.ts:60 | Regular-board limits follow Kep-00158/BEI/10-2026 | – | – | – | comment | |
| 29 | packages/relay/src/recorded-day.ts:555 | A frame carries all its book's side times and sequences | ✓ | ✓ | ✓ | **ADR** | G: A recorded book frame's side times and sequences |
| 30 | packages/relay/src/order-book.ts:35 | Each side keeps its own time and Stockbit sequence; gaps are not loss | ✓ | ✓ | ✓ | **ADR** | G |
| 31 | apps/e2e/tests/stocks.spec.ts:220 | Feb and Apr 2026 left unseeded for another spec | – | ✓ | – | comment | |
| 32 | apps/e2e/tests/market-live-sweeps.spec.ts:144 | Find the minute by hovering, not by bar index | – | ✓ | – | comment | |
| 33 | apps/e2e/playwright.config.ts:165 | Refuse a run naming only specs of a dependent project | – | ✓ | ✓ | comment | |
| 34 | scripts/e2e-evidence-plan.mts:54 | The evidence gate is a commit status, not a check run | ✓ | ✓ | ✓ | **ADR** | H: The e2e-evidence gate is a commit status |
| 35 | scripts/e2e-evidence-plan.mts:394 | Any failure blocks the evidence post | – | – | ✓ | comment | |
| 36 | scripts/e2e-evidence-plan.mts:60 | Require gh 2.99.0 for `--attach` | – | – | – | comment | |
| 37 | packages/deploy/src/target.ts:108 | Compatibility date is the newest the bundled workerd accepts | – | ✓ | ✓ | comment | |
| 38 | packages/client/src/recorded-day.ts:263 | An answer is final once the day takes no more broker codes | – | ✓ | ✓ | comment | |
| 39 | packages/server/src/bridge.ts:26 | The bridge is the only module that reaches `cloudflare:workers`, lazily | ✓ | ✓ | ✓ | **ADR** | A |
| 40 | pnpm-workspace.yaml:18 | Effect and Alchemy are pinned once, in the catalog | ✓ | ✓ | ✓ | **ADR** | I: Effect and Alchemy pinned once, matching `repos/` |

## Tally

14 of 40 rows clear the bar. They group into 9 distinct ADRs (A to I), because 5 rows restate a decision another row already holds. Scaled to 672 tag lines, that is roughly 230 pointers into roughly 150 ADRs. This is a guess from one sample.

## The rule the calls follow

Rows 3, 14, 20 and 24 are the hard ones. Each is surprising and deliberate, and a reader could "fix" it. The comment at the site already stops that, and undoing it is a one-line change. So the deciding test turned out to be **R**, and in practice R reads as this:

> A decision clears the bar when undoing it reaches beyond the line it sits on. That means one of:
> 1. It binds more than one site, across files or packages (A, C, E, G).
> 2. It shapes data that is stored or sent, so old data or deployed clients outlive a change (E, G).
> 3. It guards Production data or a platform limit (B, D).
> 4. It fixes a tool, platform or process the whole repo depends on (H, I).
>
> A choice local to one function, component, constant or test stays a why-comment, however surprising it is.
