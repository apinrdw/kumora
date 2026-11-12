# e2e

Running the Playwright suite against the Test stage.

- **Parallel runs share only the CPU.** Ports are per run (`apps/e2e/support/ports.ts`); give each run `--workers=<cores / runs>`: two runs at 8 workers on 16 cores time out sign-in specs.
- **`pnpm test:e2e -- <file>` still runs the setup project**, which signs up and verifies the shared accounts from `.eml` files first, so a one-spec run takes about 40 s.
- **Each browser context needs its own client IP.** Import `test` and `newClientContext` from `support/test.ts`: it sends a random `cf-connecting-ip` per context, so the per-IP rate limits stay on without specs eating each other's budget. A spec that builds a context with `browser.newContext` directly shares one IP.
- **CI is slower than a laptop.** Each CI shard runs 2 workers on 2 cores with a 60 s test timeout (`playwright.config.ts`); a test near 25 s locally can still hit it, so split a long journey into tests with their own accounts rather than raising it again.
- **A shard's wall time is mostly fixed cost.** About 105 s goes to job setup, server start and the setup project's cold first sign-up before any spec; per-job step times come from `gh api repos/<owner>/<repo>/actions/jobs/<id> --jq '.steps[]'`.
- **A timing fix needs a slow server to plant against.** `if (message._tag === "Frames") yield* Effect.sleep(Duration.millis(1_500))` before `market.ingest(message)` in `apps/dashboard/src/server/market-live/trading-day.ts` makes the recorded specs' pre-fix waits fail (`Expected: 5, Received: 0`).
- **A Durable Object's real platform limits only show in e2e.** Unit tests' fake socket attachment has no 16,384-byte cap, so a defect that overflows it passes every vitest suite; the Test stage's workerd refuses it ("A WebSocket 'attachment' cannot be larger than 16384 bytes").
- **Print the URLs a run would use with `bun`, not `node`.** From `apps/e2e`, `KUMORA_WEB_PORT=4567 bun -e 'const a = await import("./support/accounts.ts"); console.log(a.testUrl("web"), a.DASHBOARD)'` prints them; plain Node fails with `ERR_MODULE_NOT_FOUND` on the extensionless `./ports` import.
