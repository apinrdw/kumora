# Turbo remote caches for GitHub Actions on this repo

Research for [#166](https://github.com/apinrdw/kumora/issues/166), under map [#163](https://github.com/apinrdw/kumora/issues/163). It compares the backends and does not pick one. Picking one is [#170](https://github.com/apinrdw/kumora/issues/170).

Checked on 2026-11-11 against `turbo` 2.11.7 (installed version), `main` at `0556219dbf`.

## Short answer

Three free backends fit `ubuntu-latest` runners. Each one is set up by one workflow step plus `TURBO_*` env vars, and none needs a `turbo.json` change:

| | Vercel Remote Cache | Self-hosted Worker + R2 | GitHub Actions cache-backed server |
| --- | --- | --- | --- |
| Example | `vercel/setup-turborepo-remote-cache-action` (OIDC) or a PAT | `AdiRishi/turborepo-remote-cache-cloudflare` | `rharkor/caching-for-turbo` |
| Account | Vercel Hobby team | Cloudflare account we already have | none |
| Secrets in GitHub | none with OIDC (`TURBO_TEAM` variable); `TURBO_TOKEN` with a PAT | `TURBO_TOKEN` secret (+ `TURBO_API`, `TURBO_TEAM`) | none |
| Free limits | 100 GB uploads/month, 100 artifact requests/min (Hobby fair use) | Workers 100k requests/day; R2 10 GB-month, 1M Class A, 10M Class B, free egress | 10 GB per repo, 200 uploads/min, 1500 downloads/min |
| Retention | 7 days from upload | 30 days by default (`BUCKET_OBJECT_EXPIRATION_HOURS`), daily cron | evicted after 7 days with no access |
| PR writes reach `main`? | yes, unless PR jobs are made read-only | yes, unless PR jobs are made read-only | no: GitHub scopes a PR's entries to that PR |
| Fork PRs | no secrets → runs uncached | no secrets → runs uncached | can read the base branch's entries; writes stay PR-scoped |
| Terms | Hobby is "non-commercial personal use only" | own infra, MIT code | GitHub-native |

The cache would save less than the table suggests. `pnpm check` takes about 4m46s, and `dashboard#test` (219s) plus `//#test:root` (67s) make up most of it. Most PRs bust one or both of those tasks: 18 of the last 21 merged PRs missed at least one. The 9-minute `e2e` job does not run through turbo, so no turbo cache helps it.

## How much CI time is in turbo tasks

From the `check` job of run [42995512081](https://github.com/apinrdw/kumora/actions/runs/42995512081) (PR #161), with no cache. `pnpm check` runs five separate `turbo run` invocations:

| Invocation | Tasks | Time |
| --- | --- | --- |
| `typecheck` + `typecheck:root` | 10 | 31.4s |
| `build` | 1 (`extension#build`) | 2.4s |
| `lint` + `lint:root` | 10 | 9.5s |
| `format:check` + `format:check:root` | 10 | 7.4s |
| `test` + `test:root` | 9 | 3m47s |

The test invocation runs its tasks in parallel, so its wall time comes from the slowest tasks. Vitest durations per task: `dashboard#test` 219s, `//#test:root` 67s, `@workspace/deploy#test` 32s, `extension#test` 27s, `@workspace/client#test` 17s, `relay` 12s, `server` 11s, `web` 10s, `ui` 5s. The whole `pnpm check` step took 4m46s, and the `e2e` job took about 10 minutes. `e2e` runs `pnpm test:e2e`, which is `pnpm --filter e2e e2e`, not a turbo task.

Turbo already prints `Remote caching disabled` in every invocation, so this is a cold run every time.

## What a typical PR would hit in cache

### How turbo builds the key (installed docs)

`docs/crafting-your-repository/caching.mdx`, "Task inputs":

- **Global hash.** If it changes, every task misses. It covers the resolved task definitions, lockfile changes that affect the workspace root, source files of internal packages that the root depends on (none here: the root `package.json` has no `workspace:` dependency), `globalDependencies` contents, and `globalEnv` values. In this repo `globalDependencies` is `.oxlintrc.json`, `scripts/oxlint-plugin.mts` and `.oxfmtrc.json`.
- **Package hash.** It covers the package's `turbo.json`, lockfile changes that affect that package, its `package.json`, and by default all git-tracked files in the package directory. `inputs` replaces that default (`reference/configuration.mdx`, `inputs`), but `package.json`, `turbo.json` and lockfiles are always inputs.
- **Dependency hashes.** `dependsOn` folds them in. `typecheck`, `lint` and `build` use `^task`. `test` depends on `transit`, and `transit` depends on `^transit`, which matches no script. `transit` is the "Transit Nodes" pattern (`crafting-your-repository/configuring-tasks.mdx`): a package's `test` hash changes when any internal dependency's files change, but tests do not wait on dependency tasks. `format:check` has no `dependsOn`, so it only misses in the package that changed.
- **Root tasks.** The `//#…:root` tasks have explicit `inputs`. `//#test:root` lists `scripts/**`, `vitest.config.*`, `turbo.json`, every `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/**` and `.claude/hooks/fallow-gate.sh`, so a change to any of those files reruns its 67s.

### Measured: which tasks miss for a one-file change

Method: run `turbo run typecheck typecheck:root build lint lint:root format:check format:check:root test test:root --dry=json` on clean `main`, change one file, run it again, and count the real tasks (not `transit` or tasks with no script) whose hash changed. There are 40 real tasks.

| Change | Misses | Expensive tasks rerun |
| --- | --- | --- |
| `packages/relay/src/*.ts` | 16/40: relay, client, dashboard, e2e, extension (typecheck, lint, test, `extension#build`) | `dashboard#test`, `extension#test`, `client#test` |
| `packages/server/src/*.ts` | 10/40: server, dashboard, web | `dashboard#test` |
| `apps/dashboard/src/*` | 4/40: the dashboard's own four tasks | `dashboard#test` |
| `apps/extension/manifest.ts` | 5/40: the extension's own five tasks | `extension#test` |
| `apps/web/package.json` (a field) | 5/40: web's four tasks + `//#test:root` | `//#test:root` |
| `scripts/*.mts` | 4/40: the four root tasks | `//#test:root` |
| `.github/workflows/ci.yml` | 1/40: `//#test:root` | `//#test:root` |
| `pnpm-lock.yaml`, whitespace only | 1/40: `//#test:root` | `//#test:root` |
| `pnpm-lock.yaml`, root importer's `typescript` version | 40/40 (global hash) | everything |
| `.oxlintrc.json` (a `globalDependencies` entry) | 40/40 | everything |
| `turbo.json`, comment only | 4/40: the root tasks (task definitions unchanged) | `//#test:root` |
| `tsconfig.json` (root) | 1/40: `//#typecheck:root` | none |
| `AGENTS.md` | 0/40 | none |

A dependency change in a single package's importer section should, per the docs, miss only that package's tasks plus `//#test:root`, which hashes the whole lockfile. A hand-edited version in `apps/web`'s importer only moved `//#test:root`, probably because the edited version did not resolve to any entry under `packages:`. So that row is not measured; a real `pnpm add` would settle it.

`dashboard#test` sits behind `client`, `deploy`, `relay`, `server`, `ui` and the dashboard itself. Any tracked-file change in those six directories reruns it, including docs-only files such as `apps/dashboard/GLOSSARY.md`. The package default input is "all git-tracked files".

### Replayed against the last 21 merged PRs

`gh pr list --state merged --limit 40` returns 21 PRs. Each PR's file list was checked against the rules above, ignoring `repos/`:

- 7/21 would hit `dashboard#test`. Five of the misses were glossary-only edits to `apps/dashboard/GLOSSARY.md` (#139, #97, #79, #65, #49).
- 9/21 would hit `//#test:root`.
- 3/21 would hit both (#158, #54, #8, all docs or skills only).
- 6/21 changed a global input (#159, #157, #132, #34, #33, #9) and would miss everything.

So the two longest tasks rerun on most PRs, and most of the gain on a first push comes from the small per-package tasks: typecheck, lint, format:check and the other packages' tests. A remote cache helps much more on a second push to the same PR, or on the `main` push after a merge, because then every task the PR did not change since its last run hits. Some cheap input changes would raise the first-push hit rate, for example adding `!**/*.md` to package `inputs` with `$TURBO_DEFAULT$`, or splitting `//#test:root` so the lockfile and workflow checks do not share one task. Those are separate decisions and are out of scope here.

Artifacts will be small. Only `build` declares `outputs` (`dist/**`, which only `apps/extension` has), so every other artifact holds just the task's log. Storage limits on all three backends are far above what this repo would use. Request rate matters more than storage.

## Backend 1: Vercel Remote Cache

Sources: the installed `core-concepts/remote-caching.mdx` and `guides/ci-vendors/github-actions.mdx`; Vercel's [Remote Caching](https://vercel.com/docs/monorepos/remote-caching), [external CI/CD](https://vercel.com/docs/monorepos/remote-caching/external-ci-cd) and [fair use](https://vercel.com/docs/limits/fair-use-guidelines) pages.

**Setup with OIDC (recommended by both Turborepo and Vercel):**

1. On the Vercel team: Settings → Build and Deployment → OIDC Policies for CLI Access → add a Turborepo CLI policy for GitHub, `apinrdw/kumora`. It can be limited to one workflow or branch.
2. `gh variable set TURBO_TEAM --body <team-slug>`. A variable, not a secret, "so GitHub doesn't censor your team name in log output".
3. In the job: `permissions: { contents: read, id-token: write }` and a step `vercel/setup-turborepo-remote-cache-action` with `team: ${{ vars.TURBO_TEAM }}` before any `turbo`. The installed docs show `@v1.0.0`; the latest release is `v1.1.0` (2026-08-21). The action exchanges the GitHub OIDC token for a short-lived, team-scoped Turborepo token and exports `TURBO_TOKEN`/`TURBO_TEAM`.

**Setup with a PAT:** create a team-scoped token at vercel.com/account/tokens, run `gh secret set TURBO_TOKEN` and `gh variable set TURBO_TEAM`, then set the job's `env:` to both.

**Limits:** free on all plans under fair use. Hobby allows 100 GB uploads/month and 100 artifact requests/minute; Pro allows 1 TB and 10,000/min. Artifacts expire 7 days after upload.

The 100/min figure matters here. One `check` job makes about 40 cache lookups plus uploads for the tasks that miss, spread over about 5 minutes. A single job is well under the limit. Several PR pushes landing in the same minute could get close.

**Terms:** "Hobby teams are restricted to non-commercial personal use only." Commercial use is defined around Deployments for financial gain. Whether a CI-only cache for this project counts is for the owner to judge. A Pro team costs money, and the ticket rules that out.

**Fork PRs:** GitHub does not pass secrets to `pull_request` runs from forks, and their `GITHUB_TOKEN` is read-only (GitHub, "Events that trigger workflows"). So a PAT is absent. GitHub's OIDC page does not document `id-token: write` for forks; the read-only token implies it is not granted, but that is not verified. Turbo without a token falls back to the local cache, so the run still passes, just uncached. The repo is private with 0 forks, and fork PR workflows on a private repo only run if the "Run workflows from fork pull requests" policy is enabled, with "no access to secrets" unless "Send secrets…" is also enabled.

**Isolation:** Vercel's namespace policies (repository shared, per branch, …) apply to Vercel Builds and Vercel CI. For an external CI token, the Vercel docs describe only token-level read-only (`GET /v8/artifacts/status` → `"readOnly": true`). A same-repo PR job with full access can therefore write artifacts that `main` later replays. Mitigations in turbo itself: `--cache=local:rw,remote:r` or `TURBO_REMOTE_CACHE_READ_ONLY` on PR jobs (`reference/run.mdx`, `reference/system-environment-variables.mdx`), and/or `remoteCache.signature: true` with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` (HMAC-SHA256; artifacts that fail verification count as misses).

## Backend 2: self-hosted on Cloudflare Workers + R2

Sources: the installed `core-concepts/remote-caching.mdx` ("Self-hosting", OpenAPI v8 spec, community implementations), the [`AdiRishi/turborepo-remote-cache-cloudflare`](https://github.com/AdiRishi/turborepo-remote-cache-cloudflare) README and its [retention](https://turborepo-remote-cache.dev/retention) and [connect-turbo](https://turborepo-remote-cache.dev/connect-turbo) docs, and Cloudflare's [R2](https://developers.cloudflare.com/r2/pricing/) and [Workers](https://developers.cloudflare.com/workers/platform/pricing/) pricing pages.

Any HTTP server that implements Turborepo's Remote Cache API works: "all versions of `turbo` are compatible with the `v8` endpoints". The turbo docs list `brunojppb/turbo-cache-server`, `ducktors/turborepo-remote-cache` and `Tapico/tapico-turborepo-remote-cache`. `AdiRishi/turborepo-remote-cache-cloudflare` is the one built for Workers. It has 247 stars, its latest API release is 5.3.1 (2026-11-03), it is MIT, and it can store artifacts in R2, KV or any S3 bucket. `ducktors/turborepo-remote-cache` (1.5k stars, v3.0.3) is a Node server with S3-compatible storage. It would need a host, and a Worker is the natural host here.

**Setup:**

1. Deploy the Worker with an R2 bucket. The upstream path is the "Deploy to Cloudflare" button or `pnpm build && pnpm run deploy` with Wrangler. This repo deploys through Alchemy instead, and the vendored Alchemy has `Cloudflare.R2.Bucket` (`repos/alchemy/packages/cloudflare/src/R2/Bucket.ts`, with `lifecycleRules`) and `GitHub.Secret`/`GitHub.Variable` (`repos/alchemy/packages/github/src/`). A stack in this repo could own the bucket, the Worker and the GitHub secret, but nobody has built that yet. Upstream ships as a Nitro app, so wrapping it in Alchemy is real work.
2. Set the Worker secret `TURBO_TOKEN`, for example from `openssl rand -hex 32`. The secret could come from Infisical like the other secrets.
3. Point turbo at the server: `remoteCache.apiUrl` and `teamSlug` in `turbo.json`, or the `TURBO_API`/`TURBO_TEAM` env vars, plus the `TURBO_TOKEN` GitHub secret in the job `env:`.

**Limits (free plans):** Workers allow 100,000 requests/day and 10 ms CPU per invocation. R2 includes 10 GB-month, 1M Class A (write) and 10M Class B (read) operations per month, with free egress. Log-only artifacts stay far inside all of these. The 10 ms CPU limit should hold for a server that streams R2 objects, but nobody has measured it for this server.

**Retention:** `BUCKET_OBJECT_EXPIRATION_HOURS`, default 720 (30 days), applied by a daily 03:00 UTC cron that deletes objects by upload age. Downloads do not extend an artifact's life. The cron deletes every old object in the store, so the cache needs a bucket of its own.

**Fork PRs:** same as Vercel with a PAT. No secrets reach fork runs, so they run uncached.

**Isolation:** the server has one bearer token, and "one token opens every team", so any job with the token can write. Use the same turbo mitigations as above (`remote:r` on PR jobs, artifact signing). The token also works from laptops if we want that.

**Cost to us:** a new deployed service with its own upgrade path ("your copy doesn't follow new releases on its own"). It counts against the Cloudflare account's free Worker limits, which the apps share.

## Backend 3: a server backed by the GitHub Actions cache

Sources: the installed `guides/ci-vendors/github-actions.mdx` ("Remote Caching with GitHub actions/cache"); the [`rharkor/caching-for-turbo`](https://github.com/rharkor/caching-for-turbo) README and `src/lib/env/index.ts`; GitHub's [dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

**Two shapes:**

- **`actions/cache` on `.turbo`** (what the turbo docs show): key `${{ runner.os }}-turbo-${{ github.sha }}`, restore-key prefix `${{ runner.os }}-turbo-`. It needs no server, but it restores the whole latest directory as one blob and saves a new full copy each run. Turbo 2.11's default `cacheDir` is `.turbo/cache`.
- **A local Remote Cache server over the Actions cache API.** `rharkor/caching-for-turbo` is maintained, with latest release v2.5.2 (2026-10-19) and a push on 2026-11-10. It starts a server on `localhost:41230`, sets `TURBO_API`/`TURBO_TOKEN`/`TURBO_TEAM`, and stores each turbo artifact as its own Actions cache entry (prefix `turbogha_`). It authenticates with the runner's own `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_CACHE_URL`, so it needs no secret. It can also use S3 storage (`provider: s3`), which would point at R2. The older `dtinth/setup-github-actions-caching-for-turbo` (last release v1.3.0, 2024-05) does the same but looks unmaintained.

**Setup:** one step, `uses: rharkor/caching-for-turbo@v2` (pin an exact tag), before `pnpm check`. No account, secret or variable.

**Limits:** 10 GB per repository by default. Usage past 10 GB is billed only if the limit is raised. Entries not accessed for 7 days are removed. Up to 200 uploads/min and 1500 downloads/min per repo. The cache is shared with `actions/setup-node`'s `cache: pnpm` entries, which take most of that space. The action's own cleanup options (`max-age`, `max-size`) do not apply to the GitHub provider.

**Scoping, which also covers fork PRs:** "Workflow runs can restore caches created in either the current branch or the default branch", and PR runs "can also restore caches created in the base branch, including base branches of forked repositories". Caches written by a PR run have "a limited scope and can only be restored by re-runs of the pull request". This gives the isolation the other two backends need flags for: PR runs read `main`'s artifacts, and `main` never replays a PR's. Sibling branches cannot share entries. `ACTIONS_RUNTIME_TOKEN` is issued to every job, so fork PR runs should get the same read-from-base behavior. The action's README does not mention forks, so this is inferred from the code and GitHub's rules, not tested.

**Costs:** each artifact is a cache round-trip through GitHub's service, with no cross-machine sharing outside Actions (laptops cannot use it). It also depends on a third-party action holding the runner token, so pin it to a commit SHA.

## Open points for #170

- Whether the Vercel Hobby non-commercial clause fits this project.
- Whether PR jobs should be read-only against the remote (Vercel, Worker), or rely on GitHub's PR scoping (Actions cache).
- Whether to widen what hits first. As measured above, a remote cache alone leaves `dashboard#test` and `//#test:root` rerunning on most PRs. Narrowing their inputs is a separate choice with its own correctness risk.
- Not verified here: `id-token: write` on fork PRs, the Worker's 10 ms CPU limit under real artifact sizes, and how a real single-package `pnpm add` changes the hashes.
