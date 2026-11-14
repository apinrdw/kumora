# Can Workers Builds run an Alchemy deploy for each stage?

Research for [#13](https://github.com/apinrdw/kumora/issues/13), child of the map [#10](https://github.com/apinrdw/kumora/issues/10). Read 2026-11-05.

All dashboard claims below come from Cloudflare's docs as read on 2026-11-05, not from looking at the dashboard. Each section gives the docs page's own "last updated" date. Alchemy source claims are pinned to `alchemy-run/alchemy` at `5bbe9aa` (main, 2026-11-05).

## Answer

Mostly yes, with one real gap.

Workers Builds runs any shell command as its deploy command and its preview command, and Bun is in the build image. So `bun alchemy deploy --stage <stage> --yes` runs. What breaks:

1. **No teardown.** Workers Builds builds only on pushes. It has no event for a closed PR or a deleted branch, so nothing ever runs `alchemy destroy` for a preview stage.
2. **No PR number.** A build gets only the branch name, so a preview stage can be keyed by branch but not by `pr-<n>`.
3. **Infisical OIDC does not work.** Alchemy's Infisical login in CI needs either a ready access token or an OIDC token from a platform it detects. Workers Builds is not one of those platforms.
4. **A build must hang off an existing Worker.** You connect a repo to a Worker that already exists. No Alchemy resource manages that connection.

The closest working setup:

- One Workers Builds connection.
- A small Bun script as both the deploy command and the preview command. It maps `WORKERS_CI_BRANCH` to a stage and runs `alchemy deploy`.
- Your own Cloudflare API token as a build secret.
- An Infisical token minted at the start of each build from Universal Auth client credentials.
- Teardown runs outside Workers Builds: either a small GitHub Action on `pull_request: closed`, or a scheduled sweep.

If teardown has to stay inside Cloudflare, use Alchemy's `preview.of`, which maps to Cloudflare Worker Previews. Cloudflare then evicts the oldest Preview when the per-Worker cap is reached (100 on Free, 500 on Paid). Alchemy state for those stages still goes stale.

## Custom build and deploy commands

Source: [Configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) (last updated Sep 22, 2026).

- A build runs an optional **build command**, then a **deploy command**. The deploy command defaults to `npx wrangler deploy`, "but you may customize this command". The examples include `npm run deploy`. [Advanced setups](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/) (Sep 22, 2026) also shows `turbo deploy -F product-service`. The command does not have to be Wrangler.
- Non-production branches run a **preview command** instead. It defaults to `npx wrangler preview` and "Like the build and deploy commands, it can be customized."
- One caveat. On [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) (Oct 1, 2026), the one-time switch that moves *existing* Workers onto Worker Previews says "Custom commands must invoke `npx wrangler preview`". For new Workers the docs set no such rule. A Worker created now should not need the switch. Confirm this on the throwaway deploy.
- Workers Builds "does not honor the configurations set in Custom Builds" in the Wrangler config. That does not matter here.
- Builds have a 20-minute timeout and 8 GB of memory. Free accounts get 1 concurrent build and 2 vCPU; Paid accounts get 6 concurrent builds and 4 vCPU. Each Worker can hold 64 build variables of up to 5 KB each. Source: [Limits & pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) (Oct 28, 2026).

## Bun in the build image

Source: [Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) (last updated Oct 29, 2026).

- The image is Ubuntu 24.04 on x86_64. It ships **Bun 1.4.4**, Node 24.22.1 (Node 22.23.4 is also installed), and pnpm 9.10.0.
- You can pin versions with the `BUN_VERSION`, `NODE_VERSION` and `PNPM_VERSION` build variables. pnpm and Bun can also be pinned with the `packageManager` field in `package.json`. Workers Builds runs pnpm through Corepack. A top-level `packageManager` field wins over `PNPM_VERSION`. This repo's root `package.json` sets `"packageManager": "pnpm@11.25.0"`, so the install runs pnpm 11.25.0.
- Dependencies install automatically, and the lockfile picks the package manager. So `pnpm install` runs first, and then `bun alchemy …` runs the CLI from `node_modules`. This fits the map's rule that Bun runs the deploy tool while the workspace stays on pnpm.
- Bun does not follow semver, so Cloudflare promises 3 months' notice before a Bun update that may break builds. Pin `BUN_VERSION` to avoid surprises.

## Branch-to-stage mapping and non-production builds

Sources: [Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) (Oct 1, 2026), [Configuration § Default variables](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables) (Sep 22, 2026), [Troubleshooting § Builds API errors](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/) (Oct 30, 2026), [Alchemy Stages](https://alchemy.run/environments/stages).

- Each Worker has one **production branch**, set under Settings › Build › Branch control. Pushes to it run the deploy command.
- A single checkbox, **Enable Preview Builds**, makes every other branch run the preview command. The dashboard has no per-branch command mapping. The Builds API allows only two trigger shapes: production, which is one exact branch, and non-production, which is `*` minus named branches. "Branch patterns such as `feature/*` are not supported."
- Every build gets these variables: `CI=true`, `WORKERS_CI=1`, `WORKERS_CI_BRANCH`, `WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BUILD_UUID`. **There is no PR number variable.**
- So the stage choice has to happen in a script. Map `main` to `prod` and `staging` to `staging`. Map any other branch to a slug of the branch name. Alchemy stage names must match `[a-z0-9][-_a-z0-9]*`, so a branch like `feat/login` has to be sanitized. Alchemy also reads `ALCHEMY_STAGE`, but Workers Builds variables are static for each Worker, not per branch, so they cannot set the stage.
- The `staging` stage can come from either of two setups:
  - The `staging` branch goes through the preview trigger, and the script sends it to `staging`.
  - A second Worker connection uses `staging` as its production branch. This costs a second connection and the anchor problem below.
- Alchemy's own CI guide, [CI](https://alchemy.run/environments/ci), is written only for GitHub Actions. It uses `github.event.number` to name `pr-<n>` stages and a `pull_request: closed` job to run `alchemy destroy`. Its docs and source have **no Workers Builds guidance**. A code search of `alchemy-run/alchemy` for `WORKERS_CI` finds only a Waku README mention.

### What breaks: preview teardown

Workers Builds builds on push events only ([Build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)). Nothing fires when a PR closes or a branch is deleted. Each branch stage's resources and Alchemy state stay until something runs `alchemy destroy --stage <slug>`. The options:

- **A GitHub Action on `pull_request: closed`** that runs only `alchemy destroy`, as in Alchemy's [CI](https://alchemy.run/environments/ci) cleanup job. It needs the same Cloudflare and Infisical credentials as a GitHub secret. This bends the map's "not GitHub Actions" rule for teardown only.
- **A scheduled sweep.** It lists the stages in the state store (`alchemy state`; see [Inspecting State](https://alchemy.run/cli/inspecting-state)), finds those with no live branch, and destroys them. It still needs some scheduler outside Workers Builds.
- **Lean on Cloudflare Previews.** Deploy branch stages as `preview.of` the prod Worker ([Alchemy Worker Previews](https://alchemy.run/cloudflare/compute/previews)). Cloudflare deletes the least recently deployed Preview once the cap is reached: 100 per Worker on Free, 500 on Paid ([Previews](https://developers.cloudflare.com/workers/previews/), Sep 24, 2026). This frees the Cloudflare side only. Alchemy state rows stay, and so does any per-stage KV, D1 or R2.

## Cloudflare API token

Sources: [Configuration § API token](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token) (Sep 22, 2026), [Alchemy Profiles § CI environment variables](https://alchemy.run/environments/profiles), [Alchemy Auth Providers](https://alchemy.run/environments/auth-providers), [Alchemy State Store](https://alchemy.run/state-store).

- Workers Builds sets `CI=true`. When `CI=true`, Alchemy skips profiles and reads credentials only from the environment: `CLOUDFLARE_ACCOUNT_ID` plus `CLOUDFLARE_API_TOKEN` (or API key and email).
- Workers Builds can make its own build token. The docs list its scopes:
  - Account: Account Settings read, Workers Scripts edit, Workers KV Storage edit, Workers R2 Storage edit.
  - Zone: Workers Routes edit.
  - User: User Details read, Memberships read.

  The docs **do not say** whether that token reaches the build as `CLOUDFLARE_API_TOKEN`. Even if it does, it lacks Secrets Store access. `Cloudflare.state()` needs Secrets Store access, because it reads the state-store token and encryption key "from the Secrets Store on every run".
- Workable path: make a scoped token yourself and add it under Settings › Build › Build variables and secrets, with `CLOUDFLARE_ACCOUNT_ID`. Alchemy's [CI](https://alchemy.run/environments/ci) guide shows a `stacks/github.ts` that mints such a token with `Cloudflare.ApiToken.AccountApiToken`. For this setup, its `GitHub.Secret` sink would have to become a manual paste into Workers Builds. No Alchemy resource writes Workers Builds build secrets. The source tree under `packages/cloudflare/src` has no Workers Builds resource; the only `workersBuilds` reference is a Queue event-source type.
- In CI, Alchemy fails if the state store does not exist yet: "In CI (`CI=true`) a missing store fails the run". Run `alchemy state bootstrap` once from a local profile before the first build.
- Workers Builds accepts only user tokens for its own build token: "account-owned token support coming soon". A token you add as a build secret has no such limit, because Workers Builds never reads it.

## Infisical credentials

Sources: [Alchemy Infisical](https://alchemy.run/environments/infisical), `packages/infisical/src/AuthProvider.ts` and `packages/alchemy/src/Auth/OidcToken.ts` at `5bbe9aa`, [Infisical Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth).

- In CI, Alchemy's Infisical auth provider (`readEnvironment`) accepts exactly two inputs:
  - `INFISICAL_TOKEN`, a ready access token.
  - `INFISICAL_IDENTITY_ID`, plus an OIDC token that Alchemy detects or that you pass in `INFISICAL_OIDC_TOKEN`.

  It has **no client ID and secret path in CI**. Universal Auth client credentials work only through a local profile, and profiles are ignored when `CI=true`.
- Alchemy detects OIDC only on Vercel, GitHub Actions, GitLab CI and GCP (`OidcToken.ts`). Workers Builds documents no OIDC token, so the `INFISICAL_IDENTITY_ID` route is closed.
- That leaves `INFISICAL_TOKEN`. A Universal Auth access token expires. The default TTL is 30 days, and the login example shows 7200 s. Storing one token as a build secret means rotating it by hand. Two better options:
  - **Mint at build time (recommended).** Store `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET` as build secrets. The Bun deploy script calls `POST /api/v1/auth/universal-auth/login`, sets `INFISICAL_TOKEN`, and then runs `alchemy deploy`. The client secret has an infinite TTL by default.
  - **Set "Access Token Period".** This makes a renewable token that does not expire as long as it is renewed. Nothing in a build renews it, though, so this option fits poorly.

## Monorepo root directory for two apps

Sources: [Configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [Advanced setups § Monorepos](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/#monorepos) (both Sep 22, 2026), [Build watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/) (May 29, 2026), [Troubleshooting § Workers name requirement](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement) (Oct 30, 2026), [Alchemy Single Stack](https://alchemy.run/project-structure/monorepo-single-stack), [Multiple Stacks](https://alchemy.run/project-structure/monorepo-multi-stack).

- Cloudflare's monorepo model is one Worker per app. Each connection has its own **root directory**, where the commands run, and its own **build watch paths**. When the root directory is not the repo root, Workers Builds also reads the top-level `package.json` for `packageManager`.
- A build is tied to one Worker that already exists in the dashboard. The "name must match" rule is enforced by **Wrangler**: the error is Wrangler's own, and the override variable is `WRANGLER_CI_OVERRIDE_NAME`. An `alchemy deploy` command never runs Wrangler, so the check most likely does not apply. Confirm this on the throwaway deploy.
- Alchemy names Workers per stage, such as `myapp-prod-…` ([Stages](https://alchemy.run/environments/stages)). The Worker that holds the connection therefore cannot double as the per-stage Workers. This leaves two shapes:
  - **Single stack, one connection (simplest).** One root `alchemy.run.ts` deploys both `apps/web` and `apps/dashboard`. One Workers Builds connection has root directory `/` and is anchored on a Worker that exists only to own the trigger. Each push deploys both apps for its stage. Use watch paths to skip pushes that only touch docs.
  - **Multi-stack, two connections.** Each app has its own `alchemy.run.ts`, its own connection, its own root directory (`apps/web` or `apps/dashboard`) and its own watch paths. This doubles the anchors, the build minutes and the secret setup. It allows only 1 concurrent build on Free.
- Anchoring the connection on an Alchemy-managed prod Worker is risky. If Alchemy ever replaces that Worker, the Builds connection is lost with it, and Cloudflare documents no way to keep the connection. A small anchor Worker made by hand avoids this. The Cloudflare API has a `workers_builds` service, which `alchemy-run/distilled` wraps as `services/workers_builds.ts`. A custom Alchemy resource could manage the trigger later.

## PR feedback

Source: [GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) (Oct 15, 2026).

- Workers Builds posts a PR comment with the build status and adds a GitHub check run for each connected Worker. "A Preview URL will be provided for builds which perform `wrangler preview`". An Alchemy build will most likely get a status comment with no URL.
- For a URL, use Alchemy's `GitHub.Comment` resource ([CI](https://alchemy.run/environments/ci)). It needs a `GITHUB_TOKEN` build secret, which Workers Builds does not provide. It also needs the PR number, which Workers Builds does not give either. The script would have to look the PR up from the branch through the GitHub API.

## Open questions for a grilling ticket

1. **Teardown.** Choose one: a GitHub Action that only runs destroy (bends "not GitHub Actions"), a scheduled sweep (on what scheduler?), or Cloudflare Preview eviction with stale Alchemy state.
2. **Preview shape.** A full Alchemy stage per branch, or `preview.of` the prod Worker? A full stage isolates everything but is heavier to tear down. `preview.of` is cheap, but service bindings resolve to production.
3. **Stage names.** Branch slugs instead of `pr-<n>`? If `pr-<n>` is wanted, the script must look up the PR number from GitHub.
4. **Stack shape.** One root stack with one connection, or one stack and one connection per app?
5. **Anchor Worker.** Which Worker owns the Builds connection: one made by hand, or one Alchemy manages despite the replacement risk?
6. **Staging.** Should `staging` go through the preview trigger, or have its own connection with `staging` as the production branch?
7. **Credentials.** Who mints and rotates the Cloudflare token and the Infisical client secret, and are they pasted into Workers Builds by hand?
8. **Verify on the throwaway deploy:**
   - whether the build token is exposed as `CLOUDFLARE_API_TOKEN`
   - that a custom preview command is accepted on a new Worker
   - that no Wrangler name check runs before an Alchemy deploy command
   - whether the deploy command runs in a shell where `$WORKERS_CI_BRANCH` expands
