# Playwright workers and sharding with `apps/e2e`'s project dependencies

Research for [#165](https://github.com/apinrdw/kumora/issues/165), map [#163](https://github.com/apinrdw/kumora/issues/163). Read 2026-11-11 against Playwright 1.64.1.

## Answer

- **1 worker is the default on our runner, not a cap from the config.** The default `workers` is 50% of `os.cpus().length`, rounded down. `apinrdw/kumora` is a private repo, and GitHub gives private repos a **2-vCPU** `ubuntu-latest` (4 vCPU is for public repos). floor(2 × 50%) = 1. The `trading-day` project's `workers: 1` and the `fullyParallel` default do not lower the global count. They only decide how many test groups exist, and the printed count is min(global workers, the largest number of groups that could run at once in any phase).
- **Under `--shard` as the config stands today, shard 1 runs all 55 tests and every other shard runs nothing.** `limits` depends on `chromium` and `trading-day`, which depend on `setup`, so Playwright classes `limits` as the only *top-level* project and the other three as *dependencies*. Only top-level tests are split between shards. The shard that gets the one `too-many-attempts` file then gets every dependency project in full. The other shards have no top-level tests, so they run no dependencies either, and exit 0.
- **In general, each shard reruns the whole dependency closure of whatever top-level tests it got.** Setup projects are never split. They run in full in every shard that needs them.
- **`workers: 1` on a project is enforced per `playwright test` process.** It limits one shard's dispatcher. Shards do not coordinate, so two shards can run `trading-day` files at the same time.
- **Blob reports merge into one report with every shard's tests.** A dependency project that ran in several shards appears once per shard. The merged worker count is the sum across shards, and the duration is from the earliest shard start to the latest shard end.

## Sources

Code references are to the installed bundle `node_modules/.pnpm/playwright@1.64.1/node_modules/playwright/lib/…` (lines below). Each bundle section is labelled with its upstream file in `microsoft/playwright` `packages/playwright/src/`, given in brackets.

Docs:

- [TestConfig.workers](https://playwright.dev/docs/api/class-testconfig#test-config-workers): "Defaults to half of the number of logical CPU cores."
- [TestProject.workers](https://playwright.dev/docs/api/class-testproject#test-project-workers): "The maximum number of concurrent worker processes to use for parallelizing tests from this project."
- [TestProject.dependencies](https://playwright.dev/docs/api/class-testproject#test-project-dependencies): "List of projects that need to run before any test in this project runs."
- [Parallelism](https://playwright.dev/docs/test-parallel): "test files are run in parallel," while "tests in a single file are run in order, in the same worker process."
- [Sharding](https://playwright.dev/docs/test-sharding): without `fullyParallel`, "Playwright Test defaults to file-level granularity". With it, Playwright "runs individual tests in parallel across multiple shards." `merge-reports` "reads all blob reports from the passed directory and merges them into a single report." The page does not say how sharding treats project dependencies. That comes from the source below.
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `ubuntu-latest` has 4 CPU / 16 GB for public repositories and **2 CPU / 8 GB for private repositories**. `gh repo view` reports `apinrdw/kumora` as `PRIVATE`.

CI evidence: run [42991349154](https://github.com/apinrdw/kumora/actions/runs/42991349154) on `main` (`ubuntu-24.04` image) logs `Running 55 tests using 1 worker` and `55 passed (9.1m)`. `.github/workflows/ci.yml` runs `pnpm test:e2e` with no `--workers` or `--shard`.

## 1. Why "using 1 worker"

**Global worker count.** `lib/common/index.js:534` [`common/config.ts`]:

```js
workers: resolveWorkers(takeFirst(configCLIOverrides.debug || configCLIOverrides.pause ? 1 : void 0, configCLIOverrides.workers, userConfig.workers, "50%")),
```

`resolveWorkers` (`:631`) turns `"50%"` into `Math.max(1, Math.floor(os.cpus().length * 0.5))`. With 2 vCPUs that is 1. With 4 it would be 2.

**Project `workers`.** `:613` stores `projectConfig.workers` on the project only (`this.workers`). Nothing feeds it back into `config.workers`. It has two uses:

- The dispatcher [`runner/dispatcher.ts`, `lib/runner/index.js:5713-5740`] fills `_workerLimitPerProjectId` from it. `_findFirstJobToRun` then skips a job whose project already has that many running workers. The number of worker slots is always `config.workers` (`:5845`).
- The phase planner counts it (next paragraph).

**The printed number.** `createPhasesTask` [`runner/tasks.ts`, `:6688-6736`] groups projects into phases by dependency order: here `[setup]`, `[chromium, trading-day]`, `[limits]`. For each phase it adds up `min(project.workers ?? ∞, testGroups.length)` and sets

```js
testRun.config.config.metadata.actualWorkers = Math.min(testRun.config.config.workers, maxConcurrentTestGroups);
```

The base reporter [`reporters/base.ts`, `:1182-1187`] prints `actualWorkers ?? workers` as "using N worker(s)".

**`fullyParallel`.** Its default is `undefined` (`common/index.js:606`). `createTestGroups` [`runner/testGroups.ts`, `:2379-2447`] therefore makes one group per file (per worker hash) unless a suite is in parallel mode. This changes the group count, not the worker count. In our config, phase 2 alone has 9 `chromium` files plus `min(1, 8)` for `trading-day` = 10 groups. So `min(config.workers, 10)` can only be 1 if `config.workers` is 1. That happens when `os.cpus().length` is 2 or 3.

**Reproduction.** On a 16-core machine, the scratch copy of the config described below printed `using 5 workers`: floor(16 × 50%) = 8 global workers, capped by phase 2's 4 `chromium` files + 1 for `trading-day`. Setting `workers: 1` printed `using 1 worker`, and `workers: 2` printed `using 2 workers`.

## 2. How `--shard` splits tests when `setup` is a dependency

**Top-level and dependency projects.** `buildProjectsClosure` [`runner/projectUtils.ts`, `:2183-2203`]:

```js
if (result.get(project) !== "dependency")
  result.set(project, depth ? "dependency" : "top-level");
for (const dep of project.deps)
  visit(depth + 1, dep);
```

When a project is reached at any depth > 0, it becomes `"dependency"` and stays that way. This happens even when it was also selected directly, as every project is when no `--project` is given. In our config this gives:

| Project | Class |
| --- | --- |
| `setup` | dependency (of `chromium`, `trading-day`) |
| `chromium` | dependency (of `limits`) |
| `trading-day` | dependency (of `limits`) |
| `limits` | **top-level** (the only one) |

**Sharding.** `createRootSuite` [`runner/loadUtils.ts`, `:2560-2640`]:

1. It builds the root suite from top-level projects only. Dependency suites are prepended for reporter preprocessing, then detached again (`rootSuite._detach(dependencySuite)`).
2. When `config.shard` is set, it builds test groups from the remaining (top-level) suites with `createTestGroups(projectSuite, shard.total)` and keeps the groups `filterForShard` picks.
3. It recomputes the closure from the top-level projects that still have tests. It then re-adds **each of their dependency suites in full**, unfiltered by the shard.

`filterForShard` [`runner/testGroups.ts`, `:2462-2487`] splits the total test count, not the group count, into `shard.total` near-equal slices (`floor`, with the remainder handed to the first shards). It then gives each group to the slice its first test falls in, walking the groups in order. Groups follow project order, then file order, so each shard gets a contiguous run of files. `PWTEST_SHARD_WEIGHTS` can skew the slices.

**So, each shard reruns setup.** Any shard with at least one top-level test also runs the full dependency closure of that test's project. With today's config there is one top-level test (`too-many-attempts`), which always lands in shard 1 (slice sizes `[1, 0, …]`). Shard 1 then runs `limits` plus all of `chromium`, `trading-day` and `setup`. Shards 2…N print nothing and exit 0. An empty shard is not a "No tests found" error, because `:6666` skips that check when `config.shard` is set.

**Reproduction.** I made a scratch project with the same four projects, `testMatch`/`testIgnore` patterns, `workers: 1` on `trading-day`, and dummy tests that log their project. I ran it with the installed 1.64.1 CLI:

| Command | Ran |
| --- | --- |
| `--shard=1/2` | 20 of 20: setup 1, chromium 12, trading-day 6, limits 1 |
| `--shard=2/2` | nothing; `--list` says `Total: 0 tests in 0 files`; exit 0 |
| `--shard=1/3` | 20 of 20, same as `1/2` |
| `--shard=2/3`, `--shard=3/3` | nothing |
| `--project=chromium --project=trading-day --shard=1/3` | setup 1 + chromium `account`, `admin` (6) |
| same, `--shard=2/3` | setup 1 + chromium `sign-in`, `web` (6) |
| same, `--shard=3/3` | setup 1 + trading-day `market-live`, `relay-extension` (6), "using 1 worker" |

The last three rows show the general case. Once `limits` is not in the selection, `chromium` and `trading-day` are top-level and get split, and **every shard reruns `setup`**. The "Running N tests" count includes the setup tests.

## 3. A `workers: 1` project under sharding

- The limit lives in each process's `Dispatcher` (section 1). Each `--shard=i/N` invocation is its own process with its own dispatcher, so the limit holds within a shard only. Nothing coordinates across shards.
- Sharding splits by file group, and `trading-day`'s files are consecutive in group order (project order, then file order). So they often land in one shard, but a slice boundary can split them across two. Then two shards run `trading-day` files at the same time, each with up to one worker.
- In the phase count, a `workers: 1` project counts as at most 1 concurrent group. A shard holding only `trading-day` files reports "using 1 worker" (row `3/3` above).

## 4. A project that depends on every other project (`limits`)

- Phases [`runner/tasks.ts`, `:6706-6735`] are built in rounds. A project enters a phase only after all its `deps` are in earlier phases. `limits` therefore runs in a third phase, after `chromium` and `trading-day` have both finished. Each phase gets its own `Dispatcher` and runs to completion before the next starts (`createRunTestsTask`, `:6741`). If any dependency failed, `limits` is skipped (`hasFailedDeps`).
- Under sharding, `limits` being the sole top-level project is what makes the split collapse into shard 1 (section 2). Its dependencies are run because of `limits`, not sharded alongside it.
- `--no-deps` drops dependencies entirely (TestProject.dependencies docs), so `--project=limits --no-deps` would run `limits` alone, with no setup.

## 5. Blob report merging across shards

- **File names.** `_defaultReportName` [`reporters/blob.ts`, `:3151-3159`] names each blob `report[-<commandHash>][-<shard>].zip`, with the shard number padded to the width of the total. For example, `report-chromium-trading-day-1.zip` came from `--project=chromium --project=trading-day --shard=1/3`. Shards must be copied into one directory before merging.
- **Merging.** `mergeEvents` [`reporters/merge.ts`, `:8293-8330`] reads every zip and sorts them by `metadata.name`, then shard number, then file name. It rewrites test IDs per blob (`IdsPatcher` with the blob index), so the same test from two shards stays two entries. `mergeConfigs` (`:8405-8416`) sums `workers` and `metadata.actualWorkers`, and sets `shard: null`. `mergeEndEvents` (`:8418-8440`) gives `failed` if any shard failed, and sets duration to max(shard end) − min(shard start).
- **Reproduction.** I merged the three blob zips from the `--project=chromium --project=trading-day` shards with `merge-reports --reporter=list`. It printed `Running 21 tests using 5 workers` and listed `[setup] › accounts.setup` three times. That is 18 sharded tests plus one setup run per shard, and 2 + 2 + 1 workers. The shards ran one after another, so the reported 7.2 s is the wall time of all three.
