# e2e

Running the Playwright suite against the Test stage.

- **One run at a time per machine.** Both dev ports are fixed, so parallel worktrees collide; serialize with `flock /tmp/<lock> pnpm test:e2e`.
- **`pnpm test:e2e -- <file>` still runs the setup project**, which signs up and verifies the shared accounts from `.eml` files first, so a one-spec run takes about 40 s.
- **Each browser context needs its own client IP.** Import `test` and `newClientContext` from `support/test.ts`: it sends a random `cf-connecting-ip` per context, so the per-IP rate limits stay on without specs eating each other's budget. A spec that builds a context with `browser.newContext` directly shares one IP.
- **CI is slower than a laptop.** A test near 20 s locally can hit Playwright's 30 s on the CI runner; split a long journey into tests with their own accounts rather than raising the timeout.
- **A Durable Object's real platform limits only show in e2e.** Unit tests' fake socket attachment has no 16,384-byte cap, so a defect that overflows it passes every vitest suite; the Test stage's workerd refuses it ("A WebSocket 'attachment' cannot be larger than 16384 bytes").
