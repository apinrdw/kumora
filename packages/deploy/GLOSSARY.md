# Deploy

Deploy-time code shared by both apps' stacks, the Workers Builds deploy script and the teardown job. Never bundled into a Worker. The deploy script and the teardown job drive alchemy in-process through `alchemy/Alchemist`, loading each app's `alchemy.run.ts` by path; they never run the alchemy CLI.

## Language

**Stage**:
One deployed or local instance of an app's Alchemy stack, with its own Worker, state and secrets. Every Stage is exactly one of Production, Staging, Preview, Dev stage or Test stage.
_Avoid_: Environment (Infisical's word for `prod` and `staging`)

**Production**:
The Stage `production`, deployed from `main`. Its Workers are `kumora-web` and `kumora-dashboard`, and it alone reads Infisical `prod`.

**Staging**:
The Stage `staging`, deployed from the `staging` branch to try a release on real Cloudflare before merging.

**Preview**:
A Stage deployed from any other branch, named by a slug of the branch plus a 6-character hash of its full name. It reads Infisical `staging` and is destroyed when its PR closes or its branch is deleted.
_Avoid_: Preview environment

**Dev stage**:
A developer's local Stage, `dev_$USER`, run by `bun alchemy dev` with local emulation and local state. It reads Infisical `staging` through the developer's Alchemy profile.

**Test stage**:
The local Stage `test` that e2e runs on. It reads no Infisical environment, so its values come from the process environment.
