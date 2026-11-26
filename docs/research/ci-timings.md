# Where CI time goes

Measured for [Measure where CI time goes, per spec and per test file](https://github.com/apinrdw/kumora/issues/164) on the map [Map: Get a PR's GitHub CI to green in under 3 minutes](https://github.com/apinrdw/kumora/issues/163).

Sources: green CI runs 42995512081 (all tables) and 42991349154 (e2e cross-check, within 6 s per project), both on 2026-11-11, `ubuntu-latest` with 2 vCPU. Tables come from [`ci-timings/parse.mjs.txt`](ci-timings/parse.mjs.txt), stored as text so lint skips it; copy it to `parse.mjs` to run it: `gh run view <run> --log --job <id> > job.log`, then `node parse.mjs e2e job.log` or `node parse.mjs vitest job.log`. Turbo task times are read from the timestamps on turbo's grouped `##[group]` output, which turbo flushes when each task ends.

## Wall clock

| job    | total | what dominates                                                              |
| ------ | ----- | --------------------------------------------------------------------------- |
| e2e    | 622 s | `playwright test` 552 s; browser install 27 s; setup and install about 40 s |
| check  | 324 s | `pnpm check` 286 s; setup and install about 35 s                            |
| fallow | 71 s  | audit 17 s; setup and install about 45 s                                    |

The PR is green when e2e finishes, so e2e is the critical path.

## e2e (552 s step)

Before the first test, about 34 s: the extension build takes about 3 s, then `alchemy dev` plans in 5 s. The web app is ready at +24 s and the dashboard at +32 s, and the first test starts at +34 s. After the last test, shutdown takes about 10 s.

All 55 tests run on 1 worker, so the projects run one after another:

| project     | tests | s       |
| ----------- | ----- | ------- |
| setup       | 2     | 26.2    |
| chromium    | 19    | 156.8   |
| trading-day | 33    | 319.2   |
| limits      | 1     | 4.9     |
| **sum**     | 55    | **507** |

The `trading-day` project, which runs serially by design, is 63% of test time. Even with unlimited parallelism for every other project, the floor is about 34 + 26 + 319 + 5 ≈ 385 s, unless trading-day gets faster or splits.

| spec                                   | project     | tests | s     |
| -------------------------------------- | ----------- | ----- | ----- |
| tests/relay-extension.spec.ts          | trading-day | 4     | 105.7 |
| tests/market-live.spec.ts              | trading-day | 13    | 87.2  |
| tests/account.spec.ts                  | chromium    | 3     | 54.2  |
| tests/market-live-recorded.spec.ts     | trading-day | 2     | 45.5  |
| tests/accounts.setup.ts                | setup       | 2     | 26.2  |
| tests/password-reset.spec.ts           | chromium    | 2     | 24.1  |
| tests/market-live-watchlist.spec.ts    | trading-day | 4     | 22.7  |
| tests/market-live-recorded-day.spec.ts | trading-day | 2     | 22.3  |
| tests/sign-in.spec.ts                  | chromium    | 4     | 18.1  |
| tests/market-live-select.spec.ts       | trading-day | 6     | 18.1  |
| tests/taken-email.spec.ts              | chromium    | 1     | 17.6  |
| tests/impersonation.spec.ts            | chromium    | 2     | 16.0  |
| tests/market-live-ban.spec.ts          | trading-day | 1     | 14.0  |
| tests/suspended.spec.ts                | chromium    | 1     | 12.6  |
| tests/admin.spec.ts                    | chromium    | 3     | 9.5   |
| tests/too-many-attempts.spec.ts        | limits      | 1     | 4.9   |
| tests/market-live-order-book.spec.ts   | trading-day | 1     | 3.7   |
| tests/dashboard.spec.ts                | chromium    | 1     | 3.6   |
| tests/web.spec.ts                      | chromium    | 2     | 1.1   |

Slowest tests. Three trading-day tests take about 46 s each, roughly 138 s together. That is 43% of trading-day, from three tests out of 33. Their durations look like waiting out a fixed interval rather than doing work, but this measurement does not show the cause:

| test                                                                                                             | project     | s    |
| ---------------------------------------------------------------------------------------------------------------- | ----------- | ---- |
| relay-extension › a PIN from the options page signs in to Ajaib once, and Ajaib's frames carry the account id    | trading-day | 46.5 |
| market-live › an ingest socket that sends no token is closed with 4408                                           | trading-day | 46.3 |
| market-live-recorded › trades and order books the relay sent are read back from the store after the flush        | trading-day | 45.4 |
| relay-extension › the relay streams only in IDX hours and subscribes Ajaib's on-demand codes                     | trading-day | 32.2 |
| account › an account moves to a new email and deletes itself                                                     | chromium    | 26.8 |
| account › an account renames itself, changes its password and ends a session                                     | chromium    | 25.3 |
| relay-extension › the built extension relays fake Stockbit and Ajaib tabs to the local trading-day object        | trading-day | 22.6 |
| accounts.setup › sign up and verify member@example.com                                                           | setup       | 20.5 |
| market-live-recorded-day › the day strip opens a recorded day at its close, it replays, and Today · live returns | trading-day | 19.0 |
| password-reset › a reset link sets a new password, ends other sessions and returns to the page asked for         | chromium    | 18.9 |

## check (286 s step)

`pnpm check` runs five turbo invocations one after another, then five root scripts. Turbo got 0 cache hits.

| phase                                 | turbo `Time`        | tasks                                                       |
| ------------------------------------- | ------------------- | ----------------------------------------------------------- |
| typecheck                             | 31.4 s              | 10; `dashboard:typecheck` ends last, about 14 s after `web` |
| build                                 | 2.4 s               | 1 (`extension:build`)                                       |
| lint                                  | 9.5 s               | 10                                                          |
| format:check                          | 7.4 s               | 10                                                          |
| test                                  | 227.0 s             | 9                                                           |
| root `check-*.mts` scripts            | about 5 s           | 5                                                           |
| pnpm and turbo startup between phases | about 3 to 6 s each |                                                             |

### test phase: Vitest's own duration for each package

`dashboard:test` alone is 219 s of the phase's 227 s. Every other package finishes by +67 s, while dashboard runs alone.

| package        | files | vitest duration | sum of file times |
| -------------- | ----- | --------------- | ----------------- |
| dashboard      | 70    | 219.2 s         | 165.3 s           |
| `//#test:root` | 13    | 67.2 s          | 46.9 s            |
| deploy         | 7     | 32.4 s          | 4.4 s             |
| extension      | 11    | 27.5 s          | 2.2 s             |
| client         | 5     | 17.1 s          | 0.7 s             |
| relay          | 3     | 11.7 s          | 1.0 s             |
| server         | 2     | 10.1 s          | 1.1 s             |
| web            | 2     | 10.7 s          | 0.8 s             |
| ui             | 1     | 4.6 s           | 0.6 s             |

Two things this shows:

- **Dashboard runs its files one at a time.** Its wall time (219 s) exceeds the sum of its file times (165 s), with import at 18%. That fits Vitest's default `maxWorkers` (CPU count minus 1 in run mode, so 1 on 2 vCPU), since `apps/dashboard/vitest.config.ts` sets no pool options. I have not confirmed this against Vitest 5.0.5's source.
- **The small packages are dominated by contention and import.** They spend 10 to 32 s of wall time on about 1 to 4 s of tests, at 77 to 82% import. Turbo starts up to 10 tasks at once on 2 cores.

`dashboard:test` also runs `node scripts/auth-migrations.ts --check` after Vitest (not timed separately).

### Slowest dashboard files

| file                                                  | tests | s     |
| ----------------------------------------------------- | ----- | ----- |
| tests/server/market-live/trading-day.test.ts          | 30    | 52.08 |
| tests/server/market-live/recorded-day.test.ts         | 22    | 28.07 |
| tests/server/market-live/candles.test.ts              | 1     | 17.72 |
| tests/server/auth/admin-actions.test.ts               | 34    | 15.13 |
| tests/server/auth/abuse.test.ts                       | 13    | 11.96 |
| tests/server/auth/handler.test.ts                     | 30    | 6.80  |
| tests/server/auth/impersonation.test.ts               | 23    | 4.89  |
| tests/server/admin/accounts.test.ts                   | 16    | 4.41  |
| tests/server/auth/live-viewers.test.ts                | 9     | 4.14  |
| tests/components/market-live/watchlist-bench.test.tsx | 1     | 4.03  |

The top 3 files take 98 s, 59% of dashboard's test time. `candles.test.ts` spends 17.7 s on one test.

### Slowest root script tests

`scripts/lint-bans.test.mts` takes 32.5 s (51 tests), 69% of `//#test:root`. Next are `scripts/lib/run.test.mts` at 5.4 s and `turbo-test-graph` and `root-test-inputs` at about 3 s each.

## Not measured

- Per-test durations inside the slow Vitest files. CI prints them only per file; a local `--reporter=verbose` run would show them.
- How much `pnpm check`'s phases would overlap in one turbo invocation on 2 cores. That needs a trial run.
