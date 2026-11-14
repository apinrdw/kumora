# Deploy

Deploy-time code shared by both apps' stacks, the Workers Builds deploy script and the teardown job. Never bundled into a Worker. The deploy script and the teardown job drive alchemy in-process through `alchemy/Alchemist`, loading each app's `alchemy.run.ts` by path; they never run the alchemy CLI.

## Language

**Stage**:
One deployed or local instance of an app's Alchemy stack, with its own Worker, state and secrets. Every Stage is exactly one of Production, Staging, Preview, Dev stage or Test stage.
_Avoid_: Environment (Infisical's word for `prod` and `staging`)

**Production**:
The Stage `production`, deployed from `main`. Its Workers are `kumora-web` and `kumora-dashboard`, and it alone reads Infisical `prod`.

**Staging**:
The Stage `staging`, deployed from the `staging` branch, GitHub's default branch, where every PR but a Hotfix lands. A published Release takes one of its Candidates to Production.

**Release stage**:
Production or Staging: the two Stages with a fixed URL that outside services, such as the Google OAuth client and a Turnstile widget, are set up for.

**Preview**:
A Stage deployed from any other branch, named by a slug of the branch plus a 6-character hash of its full name. It reads Infisical `staging` and is destroyed when its PR closes or its branch is deleted.
_Avoid_: Preview environment

**Dev stage**:
A developer's local Stage, `dev_$USER`, run by `bun alchemy dev` with local emulation and local state. It reads Infisical `staging` through the developer's Alchemy profile.

**Builds connection**:
An app's Workers Builds connection, on its anchor Worker (`kumora-web-builds`, `kumora-dashboard-builds`) that Alchemy never deploys. It runs this package's deploy script for every push whose changes touch its watch paths: its own app's directory (`apps/web/**` or `apps/dashboard/**`), `packages/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json` and `.bun-version`. A connection watching the other app's directory deploys nothing when only its own app changes: on 2026-11-11 `kumora-dashboard-builds` watched `apps/web/**`, so three merges to `main` (#161, #162, #172) never reached Production.
_Avoid_: Build trigger, pipeline

**Candidate**:
A tag `v<version>-<YYYYMMDD>-<N>` on a `staging` commit tried on Staging. The date is the day it is pushed in WIB, and N counts that day's Candidates from 1, whatever their version. Its version is above Production's. `scripts/release-tag.mts` holds these rules; `.github/workflows/release.yml` deletes a tag that breaks one.
_Avoid_: RC, staging tag

**Release**:
A published GitHub Release, not a pre-release, whose tag, the Production tag `v<version>-<YYYYMMDD>`, sits on a commit carrying a Candidate of the same version. Publishing it makes `.github/workflows/release.yml` fast-forward `main` to that commit, which deploys Production. A Production tag pushed without a Release is deleted. Production is never reached through a PR from `staging`: a merge commit on `main` would stop the next fast-forward.
_Avoid_: Promotion PR, release PR, deploy

**Hotfix**:
A PR into `main` that skips Staging. Once it lands, `.github/workflows/sync-staging.yml` opens a Sync.

**Sync**:
A PR from `main` into `staging` carrying a Hotfix's commits, merged with a merge commit. Until it merges, a Release is refused.

**Test stage**:
The local Stage `test` that e2e runs on. It reads no Infisical environment, so its values come from the process environment.
