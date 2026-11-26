# Alchemy: where state lives, and how stages and PR previews work

Research for [#12](https://github.com/apinrdw/kumora/issues/12), child of the map [#10](https://github.com/apinrdw/kumora/issues/10). Researched 2026-11-05.

Sources:

- The alchemy.run docs, meaning the Effect-based Alchemy (`Alchemy.Stack`, `Cloudflare.state()`).
- The Alchemy source at [`alchemy-run/alchemy@5bbe9aa`](https://github.com/alchemy-run/alchemy/tree/5bbe9aa4d8ea8975b47e488239c04afd68f2d54c) (main, committed 2026-11-04). The docs site's source is in that repo under `website/src/content/docs/`.
- Cloudflare's developer docs, for Workers Builds and Worker Previews.

Paths below are relative to that commit unless they are URLs.

## Answer

- **State stores.** Alchemy has five: local files (the default), `Cloudflare.state()`, `AWS.state()`, `GCP.state()` and `postgresState()`. It has no R2 store. You can also write your own as an Effect `Layer`.
- **State store for us.** Use `Cloudflare.state()`. It keeps state off the build machine's disk, in a Durable Object on our own account. Bootstrap it once by hand before the first Workers Builds run, because when `CI=true` Alchemy refuses to create it.
- **Stages.** A stage is a name that matches `[a-z0-9][-_a-z0-9]*`. Each stage of a stack gets its own state and its own physical resource names. `alchemy destroy --stage <name>` removes only that stage.
- **Worker names and URLs.** If a Worker has no `name`, Alchemy names it `lowercase("<stack>-<logicalId>-<stage>-<16 random base32 chars>")`, capped at 54 characters. Its URL is `https://<name>.<account-subdomain>.workers.dev`. Set `name` to get a clean URL such as `kumora-web-staging`.
- **PR teardown.** Alchemy's documented way to tear down a PR preview is a GitHub Actions job that runs `alchemy destroy --stage pr-<n>` when the PR closes. Workers Builds has no PR-close trigger, so we have to choose another way (see [Open questions](#open-questions-for-a-grilling-ticket)).

## 1. State stores

Alchemy persists each resource's state between deploys to compute diffs. The record holds the resource type, input props, output attributes, instance ID, lifecycle status and bindings. State is keyed by stack name, then stage, then the resource's fully qualified name. Different stacks and stages are fully isolated. Source: [State Store](https://alchemy.run/state-store/) (`website/src/content/docs/state-store/index.mdx`).

| Store                | Where state lives                                                                                      | Locks concurrent deploys of one stage?                                      | Notes                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Local (default)      | `.alchemy/state/<stack>/<stage>/<fqn>.json` on disk                                                    | No                                                                          | "Works for solo development." Lost with an ephemeral filesystem.             |
| `Cloudflare.state()` | A Worker named `alchemy-state-store`, backed by a Durable Object with embedded SQLite, on your account | No lock found in source (see below)                                         | Recommended "for projects already running on Cloudflare". Encrypted at rest. |
| `AWS.state()`        | One DynamoDB table per account and region (overflow to S3)                                             | —                                                                           | Not relevant to us.                                                          |
| `GCP.state()`        | A Cloud Storage bucket, `alchemy-state-<project>`                                                      | Yes: a `__lease__.json` lease (`packages/alchemy/src/State/BucketState.ts`) | Not relevant to us.                                                          |
| `postgresState()`    | A Postgres database you run                                                                            | Yes: a session advisory lock per `(stack, stage)`                           | Needs `@effect/sql-pg`.                                                      |
| Custom               | Any Effect `Layer` that provides the `State` service                                                   | Up to you                                                                   | [Custom State Store](https://alchemy.run/state-store/custom-state-store/)    |

There is **no R2 state store**. The generic bucket store (`packages/alchemy/src/State/BucketState.ts`) is used only by `packages/aws/src/StateStore/State.ts` and `packages/gcp/src/StateStore/State.ts`. Nothing under `packages/cloudflare/src/StateStore/` uses R2.

### How `Cloudflare.state()` works

From `state-store/index.mdx` and `packages/cloudflare/src/StateStore/State.ts`:

- **Bootstrap.** The first `deploy`, `plan` or `dev` against a stack that uses this store deploys the store once. It creates:
  - the `Api` Worker, with its Durable Object, enabled on a `workers.dev` subdomain;
  - a bearer token, `AlchemyStateStoreToken`;
  - an encryption key, `StateStoreEncryptionKey`;
  - a Secrets Store, `StateStoreSecrets`, that holds the token and the key.

  These are shared by every stack and stage on the account that uses `Cloudflare.state()`.

- **In CI it does not bootstrap.** When `CI=true`, a missing store fails the run. In `State.ts`, `CI` is read as `Config.Boolean("CI").pipe(Config.withDefault(false))`. Bootstrap it once ahead of time with `alchemy state bootstrap --profile <ci-profile>`.
- **Credentials in CI.** When `CI=true`, Alchemy reads the store's credentials from the Secrets Store on every run, through a short-lived edge-preview Worker. Nothing needs to persist on disk. Outside CI, Alchemy caches them in `~/.alchemy/profiles/<profile>/state-stores/cloudflare.json`.
- **Token permissions.** Because of that edge-preview Worker, the deploy token needs **`Secrets Store Write`**: `Read` is rejected when the Worker binds the secret. Source: [CI guide](https://alchemy.run/environments/ci/) (`website/src/content/docs/environments/ci.mdx`), "Why `Secrets Store Write`?". The guide's suggested token policy is Workers Scripts Write, Workers KV Storage Write, Workers R2 Storage Write, D1 Write, Queues Write, Pages Write, Account Settings Write, Secrets Store Write and Workers Tail Read, scoped to the account.
- **Options.**
  - `workerName`: a separate store, for example one per team.
  - `accountId`: pin the store to one account.
  - `domain`: serve the store on a custom hostname instead of `workers.dev`. This needs a zone, which we don't have.
- **No stack file needed.** `alchemy state list|logs|bootstrap --backend cloudflare` works from a profile alone.
- **Locking.** Unlike the Postgres and bucket stores, I found no lease or lock in `packages/cloudflare/src/StateStore/` or `packages/alchemy/src/State/HttpStateStore.ts`. The only locks there guard the local credentials file (`CredentialsFile.ts`) and a concurrent bootstrap (`Deploy.ts`). The `HttpStateStore` client only retries transient errors. Two concurrent deploys of the same stage therefore seem not to be blocked, so serialize deploys per stage in CI. The CI guide's workflow does this with a `concurrency: deploy-${{ github.ref }}` group. I inferred this from the absence of a lock in the source; the docs don't state it.

### Fit with Workers Builds

Workers Builds sets the default build variables `CI`, `WORKERS_CI` and `WORKERS_CI_BRANCH` ([Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), read 2026-11-05). A deploy there therefore takes Alchemy's CI path:

- It reads credentials from the environment (`CLOUDFLARE_ACCOUNT_ID`, plus `CLOUDFLARE_API_TOKEN`).
- It requires the store to exist already.
- It needs no persisted disk.

Local state would be lost on every build and would orphan every resource, so `Cloudflare.state()` is the store that fits. I haven't confirmed that the `CI` value Workers Builds sets parses as a boolean for Effect's `Config.Boolean`; the Workers Builds research ticket ([#13](https://github.com/apinrdw/kumora/issues/13)) should confirm it.

## 2. Stages

Source: [Stages](https://alchemy.run/environments/stages/) (`website/src/content/docs/environments/stages.mdx`) and [`alchemy destroy`](https://alchemy.run/cli/destroy/) (`website/src/content/docs/cli/destroy.mdx`).

- **Name resolution.** Alchemy picks the stage from, in order:
  1. the `--stage <name>` flag;
  2. `$ALCHEMY_STAGE`;
  3. `live_$USER` (`deploy`, `destroy`, `plan`) or `dev_$USER` (`alchemy dev`);
  4. `live_unknown` or `dev_unknown`.
- **Valid names.** Stage names must match `[a-z0-9][-_a-z0-9]*`. A git branch such as `research/alchemy-state-stages` is **not** a valid stage name as is, because of the `/`.
- **Conventional names.** `live_<user>`, `dev_<user>`, `test_<user>`, `pr-<n>`, `staging`, `prod`.
- **Isolation.** Each stage has its own state, its own physical names, and its own logs and metrics. Deploying or destroying one stage never touches another.
- **Stage vs profile.** A stage chooses _what_ is deployed; a profile chooses _how_ Alchemy authenticates. They are independent of each other.
- **Branching in code.** The program can branch on `(yield* Stack).stage`, for example `RemovalPolicy.retain(stack.stage === "prod")`, or use `Stack.useSync` for resources declared at module scope.
- **Teardown.** `alchemy destroy --stage pr-42 --yes` deletes every resource in that one stack and stage that the state store records. `alchemy nuke` is the unscoped, account-wide variant. Don't use it.

### PR previews as Alchemy documents them

Source: `ci.mdx` and [Tutorial part 5](https://alchemy.run/cloudflare/tutorial/part-5/). The flow is a GitHub Actions workflow:

- It runs on `push` to `main` and on `pull_request` `opened`, `reopened`, `synchronize` and `closed`.
- It computes `STAGE` as follows: a PR gets `pr-<number>`, `main` gets `prod`, any other branch gets the branch name.
- The deploy job runs `alchemy deploy --stage $STAGE`. A `GitHub.Comment("preview-comment", …)` resource posts the Worker's `url` and updates it in place on each push, because its logical ID is stable.
- A `cleanup` job runs on `closed`. It checks that `STAGE` is not `prod`, then runs `alchemy destroy --stage $STAGE`.

Workers Builds has no equivalent of the `closed` trigger. Its configuration page mentions no trigger for a PR close or a branch deletion. Non-production branches run a "Preview command" (default `npx wrangler preview`) instead of the deploy command, and the build sees the branch (`WORKERS_CI_BRANCH`), not the PR number (same page, read 2026-11-05).

## 3. Worker name and `workers.dev` URL

Source: `packages/cloudflare/src/Workers/WorkerName.ts`, `packages/alchemy/src/PhysicalName.ts` and `packages/cloudflare/src/Workers/Worker.ts`.

- **`name` set.** `createWorkerName(id, name)` returns `name` verbatim.
- **`name` omitted.** It calls `createPhysicalName({ id, maxLength: 54 })` and lowercases the result. The default prefix is `${stack.name}-${id}-${stage}-`, followed by the first 16 base32 characters of the resource's instance ID.
  - The instance ID is random and stored in state, so the name is stable across deploys but changes if state is lost.
  - Characters outside `[a-zA-Z0-9-]` become `-`, so a stage like `live_sam` appears as `live-sam`.
  - If the name exceeds 54 characters, the prefix is truncated and a hash of the full name is kept.
  - The docs' example `myapp-prod-photos-7d4e` shows a different order than the source; the source is authoritative.
- **Example.** Stack `kumora`, logical ID `Web` and stage `pr-42` give `kumora-web-pr-42-<16 chars>`. That Worker serves at `https://kumora-web-pr-42-<16 chars>.<account-subdomain>.workers.dev`.
- **The `workersDev` prop** (`Worker.ts`, around line 624):
  - `true`, the default, serves the stable URL `https://<worker-name>.<account-subdomain>.workers.dev` plus version preview URLs.
  - `false` turns all `workers.dev` URLs off.
  - `{ enabled, previewsEnabled }` controls the two separately.
- **The `url` output.** A Worker's `url` is its custom domain if it has one, then its aliases, then its `workers.dev` URL. `url` is what the PR comment posts.
- **Clean URLs.** For readable, predictable URLs per stage, set `name` from the stage, for example `` name: `kumora-web-${stack.stage}` ``. The stage name must then stay DNS-safe.

### The alternative: Cloudflare Worker Previews (`preview.of`)

`Worker.ts` (around line 2275) documents a `preview` prop that maps to Cloudflare's [Worker Previews](https://developers.cloudflare.com/workers/previews/). A preview is a named copy of a parent Worker with its own URL, variables, secrets, bindings and Durable Object state. It never takes production traffic.

```ts
const parent = yield* Cloudflare.Worker.ref("Api", { stage: "prod" });
yield* Cloudflare.Worker("Api", { main: "./src/api.ts", preview: { of: parent } });
// url -> https://<stage>-<name>.<subdomain>.workers.dev
```

- **Naming.** The preview name defaults to a DNS-safe form of the stage (`pr-123`, `feat-login`). `<name>-<worker-name>` must fit in 63 characters.
- **Teardown.** Destroying the preview resource deletes the preview and leaves the parent untouched.
- **Cloudflare's limits.** Cloudflare's page (read 2026-11-05) allows 100 previews per Worker on Free and 500 on paid plans, and 100 deployments per preview. When the limit is reached, the preview deployed to least recently is evicted. The page doesn't say whether the feature is GA or beta.
- **Trade-off.** Under this model a PR preview is a preview of the prod (or staging) Worker, not a separate Worker. Cloudflare's eviction bounds the leak when no teardown runs. Alchemy's state for `pr-<n>` would still hold the record until someone runs `alchemy destroy`.

## Open questions for a grilling ticket

These feed [#17](https://github.com/apinrdw/kumora/issues/17), which this ticket blocks.

1. **Teardown on PR close.** Workers Builds can't trigger on a PR close. Which of these do we use?
   - A small GitHub Actions job that only runs `bun alchemy destroy --stage pr-<n>`. This bends "Workers Builds runs the deploys": deploys stay in Workers Builds, teardown doesn't.
   - A scheduled sweep that destroys the stages of closed PRs.
   - Worker Previews (`preview.of`), relying on Cloudflare's eviction and accepting stale Alchemy state.
2. **Preview stage names.** Workers Builds gives the branch, not the PR number. Do we name preview stages from a sanitized branch (`/` and other invalid characters mapped to `-`, then truncated), or look up the PR number?
3. **Separate Workers or Worker Previews.** Should a PR preview be its own Worker (a separate stage, with its own bindings and resources) or a Worker Preview of staging or prod?
4. **Worker names.** Do we set an explicit `name` per stage (clean URLs such as `kumora-web-staging`) or keep Alchemy's random-suffixed default?
5. **Bootstrapping the store (human task).** Who runs `alchemy state bootstrap` once? Which credential runs it, and which token does Workers Builds use, with `Secrets Store Write` included? Is that token minted with `Cloudflare.ApiToken.AccountApiToken` in a separate admin stack, or by hand and stored in Infisical?
6. **Concurrency.** The Cloudflare store has no lock that I could find. Do we accept that Workers Builds may run concurrent builds of one branch, or add a guard?
7. **One store or two.** One `alchemy-state-store` for the whole account, or a separate `workerName` store for prod?
