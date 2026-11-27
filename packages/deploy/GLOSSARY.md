# Deploy

Deploy-time code shared by both apps' stacks, the Workers Builds deploy script and the teardown job. Never bundled into a Worker. The deploy script and the teardown job drive alchemy in-process through `alchemy/Alchemist`, loading each app's `alchemy.run.ts` by path; they never run the alchemy CLI.

## Language

**Stage**:
One deployed or local instance of an app's Alchemy stack, with its own Worker, state and secrets. Every Stage is exactly one of Production, Staging, Preview, Dev stage or Test stage.
_Avoid_: Environment (Infisical's word for `prod` and `staging`)

**Production**:
The Stage `production`, deployed from `main`. Its Workers are `kumora-web` and `kumora-dashboard`, and it alone reads Infisical `prod`.

**Staging**:
The Stage `staging`, deployed from the `staging` branch, GitHub's default branch, where every PR but a Hotfix lands. A published Release takes one of its commits to Production.

**Release stage**:
Production or Staging: the two Stages with a fixed URL that outside services, such as the Google OAuth client and a Turnstile widget, are set up for.

**Preview**:
A Stage deployed from any other branch, named by a slug of the branch plus a 6-character hash of its full name. It reads Infisical `staging` and is destroyed when its PR closes or its branch is deleted, or by the Preview sweep once it is a Stale Preview. A merged PR's branch is deleted with it.
_Avoid_: Preview environment

**Prototype branch**:
A branch under `prototype/`, pushed for its Preview and never meant for a PR. Its Preview lives until the branch is deleted.

**Stale Preview**:
A Preview whose branch is gone; or whose branch's latest PR is merged or closed with none open; or, outside a Prototype branch, whose branch never had a PR and whose head commit is more than 3 days old.
_Avoid_: Orphan Preview

**Preview sweep**:
The daily job that destroys every Stale Preview it finds in the Alchemy state store. It also runs by hand, dry or for real.

**Dev stage**:
A developer's local Stage, `dev_$USER`, run by `bun alchemy dev` with local emulation and local state. It reads Infisical `staging` through the developer's Alchemy profile.

**Builds connection**:
An app's Workers Builds connection, on its anchor Worker (`kumora-web-builds`, `kumora-dashboard-builds`) that Alchemy never deploys. It runs this package's deploy script for every push whose changes touch its watch paths: its own app's directory (`apps/web/**` or `apps/dashboard/**`), `packages/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json` and `.bun-version`. A connection watching the other app's directory deploys nothing when only its own app changes: on 2026-11-11 `kumora-dashboard-builds` watched `apps/web/**`, so three merges to `main` (#161, #162, #172) never reached Production.
_Avoid_: Build trigger, pipeline

**Release version**:
The product's version, `version` in the root, `apps/dashboard` and `apps/web` `package.json`, always equal to each other. A Release tag names it, so it is bumped on `staging` before the tag is pushed.

**Release tag**:
A tag `v<version>-<YYYYMMDD>` pushed on a `staging` commit, waiting for its Release. Its version equals the Release version at that commit and is above Production's; its date is the day it is pushed in WIB. One never released stays and deploys nothing.
_Avoid_: Candidate, RC, Production tag

**Release**:
A published GitHub Release, not a pre-release, on an existing Release tag. Publishing it makes `.github/workflows/release.yml` fast-forward `main` to the tag's commit, which deploys Production. Production is never reached through a PR from `staging`: a merge commit on `main` would stop the next fast-forward.
_Avoid_: Promotion PR, release PR, deploy

**Hotfix**:
A PR into `main` that skips Staging. Once it lands, `.github/workflows/sync-staging.yml` opens a Sync.

**Sync**:
A PR from `main` into `staging` carrying a Hotfix's commits, merged with a merge commit. Until it merges, a Release is refused.

**Test stage**:
The local Stage `test` that e2e runs on. It reads no Infisical environment, so its values come from the process environment.
