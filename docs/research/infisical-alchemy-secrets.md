# How Infisical secrets reach an Alchemy deploy and the Worker runtime

Research for [#14](https://github.com/apinrdw/kumora/issues/14), child of the map [#10](https://github.com/apinrdw/kumora/issues/10). Researched 2026-11-05.

Sources:

- Alchemy source at commit [`5bbe9aa`](https://github.com/alchemy-run/alchemy/tree/5bbe9aa4d8ea8975b47e488239c04afd68f2d54c) (2026-11-04). `@alchemy.run/infisical` is version `2.0.0-beta.85`. Paths below are relative to that tree.
- Alchemy docs, read from the same tree under `website/src/content/docs/`. They are published at alchemy.run.
- infisical.com/docs and developers.cloudflare.com, fetched 2026-11-05.

## Answer

1. **Alchemy has a first-party Infisical secrets provider.** `@alchemy.run/infisical` exports `Infisical.Secrets(...)`. It goes in the Stack's `secrets` list. It downloads one Infisical project, environment, and folder into an Effect `ConfigProvider`. Nothing is written to `process.env` or to disk. No Infisical CLI, `infisical run`, or Infisical-to-Cloudflare sync is needed.
2. **The deploy's own credentials can come from Infisical.** Alchemy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through Effect `Config`, and Config resolves through the same `secrets` list. The Cloudflare state store has no separate credential: Alchemy derives its bearer token from the Cloudflare API token. Infisical's own credentials are the exception. They come only from the real process environment.
3. **Worker runtime secrets come from `Config` too.** A `Config` value that a Worker yields during the Construction phase is bound as a `secret_text` binding at deploy time. So is one placed on the Worker's `env` prop. With Infisical in the `secrets` list, that value comes from Infisical.
4. **Workers Builds has no OIDC that Alchemy knows about.** A build would store a machine identity's Universal Auth client ID and client secret as Workers Builds build secrets. It would exchange them for a short-lived access token, export that as `INFISICAL_TOKEN`, and then run `bun alchemy deploy`.
5. **Each stage picks its own Infisical environment.** `Infisical.Secrets` accepts a callback that receives `{ stage }`, so `prod`, `staging`, and `pr-*` can each map to an Infisical environment. Separation enforced by access rights, rather than by convention, needs either separate machine identities with environment-scoped access or separate projects. Environment-scoped custom roles are an Enterprise feature.
6. **Secrets are stored in state.** Alchemy writes `Redacted` values to state in cleartext, inside a `__redacted__` envelope. `Cloudflare.state()` encrypts every row at rest with AES-CTR, using a key kept in Cloudflare Secrets Store. `localState()` writes plain JSON under `.alchemy/state/`.

## 1. Alchemy's Infisical provider

`packages/infisical/src/SecretsProvider.ts`:

```ts
secrets: [
  Infisical.Secrets(({ stage }) => ({
    project: "my-app",            // slug, or UUID (a user token needs the UUID)
    environment: stage === "prod" ? "prod" : "dev",
    path: "/api",                 // default "/"
    // recursive: false, includeImports: true
  })),
],
```

- The provider calls the Infisical v4 list-secrets API with `viewSecretValue: true` and `expandSecretReferences: true`. It merges imported secrets first, so a directly defined secret wins. The result becomes `ConfigProvider.fromEnv({ env })`, added as primary (`downloadSecrets`, `Secrets`).
- It never logs values. With `--log-level debug`, `logLoadedKeys` logs key names only (`website/.../environments/secret-providers.mdx`, "Seeing what loaded").
- Precedence: later `secrets` entries override earlier ones, and the process environment is an implicit last entry. Use `Alchemy.Secrets.ProcessEnv()` to rank the shell elsewhere, or pass `{ disabled: true }` to leave it out (`secret-providers.mdx`, "Precedence").
- During offline auth-provider discovery, the provider returns an empty provider (`SuppressMissingProviderConfig`).

### How the provider authenticates (`packages/infisical/src/AuthProvider.ts`)

| Context                                      | Mechanism                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment, which takes precedence anywhere | `INFISICAL_TOKEN`, a ready access token. Otherwise `INFISICAL_IDENTITY_ID` plus a platform OIDC JWT, exchanged through `loginWithOidcAuth`. `INFISICAL_API_URL` selects the EU cloud or a self-hosted instance. `INFISICAL_OIDC_TOKEN` and `INFISICAL_OIDC_AUDIENCE` override the OIDC token and audience. |
| Local profile                                | `alchemy profile edit --add Infisical`, using `universal-auth` (client ID and secret) or `access-token` (a user token, valid 10 days). With Universal Auth, Alchemy mints a fresh access token on every run.                                                                                               |

- **CI never reads profiles.** `packages/alchemy/src/Auth/Resolve.ts` (`resolveProviderConfig`): when `CI` is true and no environment credentials are present, Alchemy calls `readEnvironment` and fails if nothing is set. The Doppler page says the same: "Profiles are never consulted in CI" (`environments/doppler.mdx`).
- **OIDC auto-detection** covers Vercel, GitHub Actions, GitLab CI, and GCP only (`packages/alchemy/src/Auth/OidcToken.ts`, `SUPPORTED_OIDC_PLATFORMS`). Cloudflare Workers Builds is not on the list.
- **Infisical's credentials come from the real process environment.** `CredentialsConfig` in `packages/alchemy/src/Secrets/Provider.ts` reads `INFISICAL_TOKEN`, `INFISICAL_IDENTITY_ID`, and `CI` from the shell only. An earlier `secrets` entry, such as a `.env` file, cannot supply them.

## 2. Deploy-process credentials

- **Cloudflare API token.** The Cloudflare auth provider reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through `getEnvRequired` and `getEnvRedacted` (`packages/cloudflare/src/Auth/AuthProvider.ts:481-484`). Those are `Config` reads (`packages/alchemy/src/Auth/Env.ts`). The docs confirm they go through the `secrets` list: "Cloud credentials such as `CLOUDFLARE_API_TOKEN` go through the same list, so with the shell disabled they must come from a provider" (`secret-providers.mdx`). So the token can live in Infisical rather than in Workers Builds.
- **State-store credentials (`Cloudflare.state()`).** These do not need their own secret. `loginWithCloudflare` in `packages/cloudflare/src/StateStore/State.ts` works in four steps:
  1. It finds the account's Secrets Store.
  2. It uploads a short-lived edge-preview Worker that reads the `AlchemyStateStoreToken` secret.
  3. It derives the state-store URL.
  4. It caches `{ url, authToken }` under `~/.alchemy/profiles/{profile}/state-stores/cloudflare.json`, but only when not in CI (`if (!isCI)`).

  So the Cloudflare API token is the only credential the state store needs. Which scopes that token needs (Secrets Store, Workers Scripts, previews) is a question for the state/stages research.

## 3. Worker runtime secrets

From `website/.../environments/secrets.mdx` and `cloudflare/security/secrets-env.mdx`:

- An Effect Worker binds any `Config` it yields in Construction (the outer `Effect.gen`) to the Worker. It always binds as `secret_text`, whatever the `Config` constructor. A `Config` yielded only inside `fetch` is **not** bound. The docs call this the "Footgun".
- An async Worker, such as a TanStack Start server entry that is not written as an Effect Worker, declares bindings on the `env` prop, for example `env: { API_KEY: Config.Redacted("API_KEY") }`. The shape decides the binding type: `Redacted` becomes `secret_text`, `string` becomes `plain_text`, and anything else becomes `json`. `Cloudflare.InferEnv<typeof Worker>` types the handler's `env`.
- Alchemy binds the source value, not the transformed one. Combinators such as `withDefault` run again at runtime.
- Secrets that Alchemy generates itself (webhook secrets, bearer tokens) use `Alchemy.Random`, which persists in state. Secrets shared across Workers that must rotate without a redeploy use `Cloudflare.SecretsStore`.
- Cleanup: the Worker attribute `secretNames` records the secret bindings Alchemy uploaded. A full deploy deletes the ones it no longer uploads. "Secrets set outside Alchemy are never listed, and never deleted" (`packages/cloudflare/src/Workers/Worker.ts`, `secretNames`).

### Infisical's Cloudflare Workers secret sync is a rival path

Infisical's [Cloudflare Workers secret sync](https://infisical.com/docs/integrations/secret-syncs/cloudflare-workers) pushes one environment and path into the secrets of one Workers script. Its options are auto-sync, initial sync behavior "Overwrite Destination Secrets", a key schema, and "Disable Secret Deletion". If a version is pending, the sync creates a new version and does not deploy it. The sync targets a fixed, named script, so it cannot follow per-PR preview Workers that Alchemy creates and destroys. It would also give the same binding two owners. With `Infisical.Secrets` plus `Config` the sync is unnecessary. Not recommended.

## 4. Infisical from Workers Builds

Workers Builds facts, per the [configuration docs](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) fetched 2026-11-05:

- It has a build command, a deploy command (default `npx wrangler deploy`), and a non-production-branch "Preview command".
- It injects `CI=true`, `WORKERS_CI=1`, `WORKERS_CI_BUILD_UUID`, `WORKERS_CI_COMMIT_SHA`, and `WORKERS_CI_BRANCH`.
- "Build variables and secrets" are set under the Worker's **Settings > Build**. They are build-only and "will not be accessible at runtime".
- Neither these docs nor a search of developers.cloudflare.com (2026-11-05) describe an OIDC identity token issued to builds.

Because `CI=true`, Alchemy uses only environment credentials, and Workers Builds offers no OIDC token. That leaves two options for `INFISICAL_TOKEN`:

1. **Mint per build (recommended).** Store a machine identity's Universal Auth client ID and client secret as build secrets. In the deploy command, exchange them for an access token and run the deploy in the same shell. Two ways to do the exchange:
   - Call `POST /api/v1/auth/universal-auth/login` with form fields `clientId` and `clientSecret`, then read `accessToken` from the response ([Universal Auth docs](https://infisical.com/docs/documentation/platform/identities/universal-auth)).
   - Run the Infisical CLI: `infisical login --method=universal-auth --client-id … --client-secret … --silent --plain` prints only the token. The CLI also reads `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` ([CLI reference](https://infisical.com/docs/cli/reference-agents)). This requires installing the CLI in the build image.

   The rest of the deploy reads from Infisical. A small Bun script could do the exchange with no extra dependency, because `@alchemy.run/infisical` exports `mintAccessToken`. Note that `INFISICAL_TOKEN` must be in the real environment before Alchemy starts, so a wrapper script would need to set it and spawn the deploy.

2. **Store a ready access token in `INFISICAL_TOKEN`.** This is simpler, but access tokens default to a 30-day TTL and a 30-day max TTL. The docs page is inconsistent: its sample response and a note cite 7200 s. Either way, someone must rotate the token by hand. A periodic token (Access Token Period) does not expire but needs `/renew` calls. Not recommended.

Universal Auth defaults, per the Universal Auth docs (2026-11-05): client secret TTL `0` (never expires), max uses `0` (unlimited), trusted IPs `0.0.0.0/0`. Trusted-IP restriction is a Pro feature on Infisical Cloud.

Without Infisical, the minimum set of build secrets is `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`, or whatever names the wrapper reads. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` can live in Infisical. Workers Builds settings are per Worker, so `apps/web` and `apps/dashboard` each need the build secrets, unless one build deploys both apps.

## 5. Per-stage separation

- **Selection.** Both `secrets` and `Infisical.Secrets` options accept a callback that receives `{ stage, stack, alchemyContext }` (`packages/alchemy/src/Secrets/Provider.ts`, `SecretsOption`). A possible mapping: `prod` → `prod`, `staging` → `staging`, `pr-*` → `staging` or a dedicated preview environment.
- **Enforcement.** The callback only chooses an environment. Whatever token the build holds decides what it can actually read. To stop a preview build from reading prod secrets, the identity used for non-prod builds must lack read access to the prod environment. On the Infisical side:
  - Custom project roles can restrict access "to specific secrets, folders, and environments". The [RBAC docs](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls), fetched 2026-11-05, list custom roles as Enterprise. Built-in roles are on all plans.
  - Without custom roles, the plan-independent way to enforce separation is **two Infisical projects** (prod, and non-prod with staging and preview environments), each with its own machine identity. The alternative is one project with "No Access" plus Additional Privileges, if the plan includes them. This was not verified.
- **Different credentials per stage on Workers Builds.** Build secrets are set per Worker, not per branch, so prod and preview builds of one Worker share build secrets. Two ways to use different Infisical credentials per stage:
  - Have the wrapper choose between two credential pairs by `WORKERS_CI_BRANCH`. This is weak, because every build holds both pairs.
  - Split prod and non-prod into separate Workers Builds configurations.

  The Workers Builds ticket owns how stages map to builds. This research only flags that the per-Worker scoping of build secrets limits isolation.

- **Cloudflare token per stage.** If `CLOUDFLARE_API_TOKEN` lives in Infisical per environment, prod and non-prod deploys can use differently scoped Cloudflare tokens with no change to Workers Builds.

## 6. Secrets in state

- `packages/alchemy/src/State/StateEncoding.ts` (`encodeState`): "`Redacted<T>` values are wrapped as `{ __redacted__: <inner> }` so the actual string is persisted". Resource `props` are persisted (`State/ResourceState.ts`), so a Worker's `env` secrets are in state in cleartext before any store-level encryption. The Worker's metadata hash also covers secret values by content (`resolveMetadataHashValue`, `WorkerProvider.ts`).
- **`Cloudflare.state()`** keeps state in a Durable Object (`packages/cloudflare/src/StateStore/Store.ts`). It encrypts every resource row and stack output with AES-CTR, using a random nonce per write. The 32-byte key is `StateStoreEncryptionKeyValue` (`StateStore/Token.ts`), stored in the account Secrets Store as `StateStoreEncryptionKey` and bound only into the state-store Worker. The deploy never sees the key. Alchemy v1's `ALCHEMY_PASSWORD` and `alchemy.secret()` have no counterpart here; `Config.Redacted` plus the encrypted store replaces them.
- **`localState()`** writes `.alchemy/state/{stack}/{stage}/*.json` with no encryption (`packages/alchemy/src/State/LocalState.ts`). It is fine for local experiments, but Workers Builds needs the remote store in any case.

## Open questions for a grilling ticket

1. **Infisical layout.** One project with `prod`, `staging`, and `preview` environments, or separate prod and non-prod projects? This depends on the Infisical plan, because environment-scoped custom roles are Enterprise.
2. **Which Infisical environment previews read:** `staging`, or a dedicated `preview` environment.
3. **Token exchange in Workers Builds.** A Bun wrapper using `mintAccessToken` from `@alchemy.run/infisical`, `curl` against the login API, or the Infisical CLI. Also: what client secret TTL or use limit to set, and who rotates it.
4. **Where `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` live.** Per environment in Infisical (recommended, which allows scoped tokens per stage), or as Workers Builds build secrets.
5. **Prod/non-prod credential isolation on Workers Builds**, given that build secrets are per Worker and not per branch. This couples with the Workers Builds stage-mapping ticket.
6. **Runtime secrets that rotate without a redeploy.** Should any go to Cloudflare Secrets Store rather than `secret_text` bindings?
7. **The TanStack Start server entry.** Is it an Effect Worker (Construction-phase `Config`) or an async Worker (`env` prop)? This decides how runtime secrets are declared. It couples with the TanStack Start research.
