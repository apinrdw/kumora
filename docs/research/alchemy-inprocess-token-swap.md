# The deploy token swap under in-process Alchemist

Research for [#107](https://github.com/apinrdw/kumora/issues/107), child of the map [#98](https://github.com/apinrdw/kumora/issues/98). It follows the [#104](https://github.com/apinrdw/kumora/issues/104) decision to drive alchemy in-process through `alchemy/Alchemist` (`importStack`, `plan`, `apply` under `Alchemist.layer()`).

Sources checked on 2026-11-07 against the vendored `repos/alchemy` (`alchemy` 2.0.0-beta.85) and `repos/effect` (`effect` 4.1.2), the versions the `pnpm-workspace.yaml` catalog pins. Paths starting with `alchemy/`, `infisical/` or `cloudflare/` are under `repos/alchemy/packages/`; `effect/` is `repos/effect/packages/effect/`. Claims marked **(probed)** were run against the installed packages with Bun 1.4.4 and dummy values (see [The probe](#the-probe)).

## Answer

- **A `ConfigProvider` provided over `Alchemist.layer()` reaches nothing in the stack.** Two barriers. `Alchemist.plan` replaces the ambient provider with its own `fromEnv()` snapshot (plus `./.env`) before it builds the stack. A stack that declares `secrets` then replaces that too: it folds its list onto an empty provider. **(probed)**
- **Every provider reads `process.env`, not the ambient provider.** The implicit `Secrets.ProcessEnv` is `ConfigProvider.fromEnv()`. `Infisical.Secrets` reads its own credentials (`INFISICAL_TOKEN`, `INFISICAL_IDENTITY_ID`, `CI`) through `CredentialsConfig`, a fresh `fromEnv()` view that ignores both the ambient provider and the stack's list. The Cloudflare credential lookup reads `CLOUDFLARE_API_TOKEN` through the stack's merged list, where `ProcessEnv` comes last and wins. **(probed)**
- **Recommended mechanism: a scoped `process.env` mutation in `deploy.ts`.** Set `INFISICAL_TOKEN` and delete `CLOUDFLARE_API_TOKEN` in an `Effect.acquireRelease` around `plan` and `apply`. `fromEnv()` snapshots `process.env` when each layer builds, which is inside `plan`, so a mutation made after alchemy and the stack are imported still lands. It is the only way to give Infisical its token: no `secrets` entry can, because `CredentialsConfig` reads the real environment by design. It also keeps the Vite build child's environment as it is today, because that child inherits the live `process.env`. **(probed)**
- **`Secrets.ProcessEnv({ disabled: true })` alone does not work.** It stops the Workers Builds token from overriding Infisical's, but Infisical still needs `INFISICAL_TOKEN` in `process.env`. It also drops every shell variable from the stack, for every stage that shares `stack.ts`. Listing `Secrets.ProcessEnv()` first (as a fallback under Infisical) fixes the Cloudflare token without disabling the shell, and is an option for a later change, but it does not remove the mutation.
- **cwd:** Workers Builds runs `deploy.ts` from `apps/<app>` (its Root directory), so the cwd the CLI had does not change. Three things still read the cwd: alchemy's `.alchemy` directory, Bun's `.env` autoload (and alchemy's own `./.env` read), and `importStack`'s path. None reaches Vite: `websiteProps` passes `rootDir: import.meta.dirname`, and the build child runs in that directory. `teardown.ts` runs from the repo root, so its `.alchemy` lands there (gitignored).

## 1. Why an ambient `ConfigProvider` cannot reach the stack

| Fact | Source |
| --- | --- |
| `Alchemist.layer()` merges `ConfigProvider.layer(ConfigProvider.fromEnv())` with its other services. A caller can still provide a `ConfigProvider` over it. | `alchemy/src/Alchemist/Runtime.ts` line 70 |
| `plan` builds the stack through `buildServices`, which merges `configServices(options)`. `configServices` calls `loadConfigProvider(envFile)` and provides `ConfigProvider.layer(withProfileOverride(commandConfig, options.profile))`. This replaces whatever provider the caller set. | `alchemy/src/Alchemist/Operations.ts` lines 47–87 |
| `loadConfigProvider` builds a fresh `ConfigProvider.fromEnv()` and layers it over `./.env` when that file exists in the cwd. | `alchemy/src/Util/ConfigProvider.ts` lines 125–145 |
| `Stack.build` provides `stackConfigLayer(options.secrets)` to the providers and the state store. | `alchemy/src/Stack.ts` line 326 |
| With `secrets` declared, `stackConfigLayer` appends `ProcessEnv()` unless the list already holds one, then folds the entries over `ConfigProvider.fromEnv({ env: {} })`, an empty provider. Each entry sees only the entries before it. `ALCHEMY_PROFILE` alone comes from `--profile` or the real `process.env`. With `secrets` omitted it is `Layer.empty`. | `alchemy/src/Util/ConfigProvider.ts` lines 58–118 |
| `ConfigProvider.fromEnv()` copies `process.env` (and `import.meta.env`) when it is called. `fromEnv({ env })` uses only the given record. | `effect/src/ConfigProvider.ts` lines 945–956 |
| In Bun, `import.meta.env` and `process.env` are the same object, so deleting a key from `process.env` also removes it from what `fromEnv()` reads. **(probed)** | probe step 0 |

`stack.ts` always declares `secrets` (a callback), so the second barrier applies to every kumora stage. The probe shows the first barrier alone is enough: with no `secrets` option, a value set only in the ambient provider is still `<unset>` inside the stack program.

## 2. Where each provider reads its values

| Provider | Reads | Source |
| --- | --- | --- |
| `Secrets.ProcessEnv()` (implicit, last) | `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`, built when the stack's layer builds. Added with `layerAdd(..., { asPrimary: true })`, so it overrides every earlier entry. `disabled: true` makes it `fromEnv({ env: {} })`. | `alchemy/src/Secrets/ProcessEnv.ts` lines 34–50 |
| `Infisical.Secrets` values | Downloads the selected environment and adds it with `layerAdd(fromEnv({ env }), { asPrimary: true })`. | `infisical/src/SecretsProvider.ts` lines 184–201 |
| `Infisical.Secrets` credentials | `resolveCredentials` runs `resolveProviderConfig("Infisical")` under `Effect.provide(CredentialsConfig)`. | `infisical/src/SecretsProvider.ts` lines 96–107 |
| `CredentialsConfig` | A `ConfigProvider.make` that answers `ALCHEMY_PROFILE` from the pinned provider and every other key from a new `fromEnv()`. Its doc comment states the intent: "Nothing loaded by an earlier entry can stand in for them". | `alchemy/src/Secrets/Provider.ts` lines 56–73 |
| Infisical environment auth | `readEnvironment` reads `INFISICAL_API_URL`, then `INFISICAL_TOKEN`, then `INFISICAL_IDENTITY_ID` plus a platform OIDC token, through `Config` (here: `CredentialsConfig`). | `infisical/src/AuthProvider.ts` lines 221–246; `alchemy/src/Auth/Env.ts` lines 7–37 |
| Env vs profile choice | `resolveProviderConfig` uses environment credentials when any of the provider's variables is present, else environment credentials when `CI` is true, else the stored profile. | `alchemy/src/Auth/Resolve.ts` lines 47–104 |
| Cloudflare credentials | `fromAuthProvider` uses `lazyCredentials`, which captures the ambient `ConfigProvider` at layer build (`deferUntilFirstUse`). Providers and state build under `stackConfigLayer`, so that is the stack's merged list. `readEnvironment` reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (or key plus email) through `Config`. | `cloudflare/src/Credentials.ts` lines 53–75; `alchemy/src/Auth/Resolve.ts` lines 116–124, 175–200; `cloudflare/src/Auth/AuthProvider.ts` lines 480–505 |

What this means for the token swap:

- `CLOUDFLARE_API_TOKEN` resolves through the stack's list, so the Workers Builds token in `process.env` beats Infisical's scoped token. That is the hazard the `deploy.ts` Decision (apinrdw/kumora#20) removes. In-process, it must still be removed from `process.env`, or `ProcessEnv` must move or be disabled.
- `INFISICAL_TOKEN` resolves through `CredentialsConfig` only. It must be in `process.env` when the stack's secrets layer builds, which is during `plan`. Nothing else works: not the ambient provider, not a `secrets` entry placed before Infisical. **(probed, steps 7–9)**

## 3. The options

| Option | `CLOUDFLARE_API_TOKEN` | `INFISICAL_TOKEN` | Side effects |
| --- | --- | --- | --- |
| `ConfigProvider` over `Alchemist.layer()` (the #104 plan) | Not removed | Not seen | None. It does nothing. |
| `Secrets.ProcessEnv({ disabled: true })` in `stack.ts` | Infisical's wins | Still needs `process.env` | Every shell variable leaves the stack (`CI`, `CLOUDFLARE_ACCOUNT_ID`, anything else not in Infisical) for every stage that uses `stack.ts`, including `alchemy dev`. Infisical's own auth is unaffected, because `CredentialsConfig` bypasses the list. |
| `[Secrets.ProcessEnv(), ...Infisical]` in `stack.ts` | Infisical's wins | Still needs `process.env` | The shell becomes a fallback for every key, so a Workers Builds variable can no longer override an Infisical value. Also protects a local `alchemy deploy` run with a token exported. |
| Scoped `process.env` mutation in `deploy.ts` | Removed | Set | Same environment the child got today, for the engine and for the Vite build child. Process-global, so it must wrap all of `plan` and `apply`. |

Recommended: the mutation, in one `Effect.acquireRelease` in `deploy.ts`:

```ts
const swapTokens = (token: Redacted.Redacted<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = process.env.CLOUDFLARE_API_TOKEN
      // Decision: drop the token Workers Builds injects. ... See apinrdw/kumora#20.
      delete process.env.CLOUDFLARE_API_TOKEN
      process.env.INFISICAL_TOKEN = Redacted.value(token)
      return saved
    }),
    (saved) =>
      Effect.sync(() => {
        if (saved !== undefined) process.env.CLOUDFLARE_API_TOKEN = saved
        delete process.env.INFISICAL_TOKEN
      })
  )

// inside Effect.scoped, before Alchemist.plan:
yield* swapTokens(token)
const plan = yield* Alchemist.plan({ stack, operation: "deploy", stage, updateStateStore: true })
yield* Alchemist.apply(plan)
```

Why the scope covers `apply` too: the Vite build child is spawned with `extendEnv: true` from the live `process.env` (`cloudflare/src/Workers/ViteChild.ts` lines 210–240), and the Vite dev child spreads `...process.env` (lines 113–116). Restoring before the build runs would hand the child the Workers Builds token again. `deploy.ts` exits right after, so the release matters for tests more than for production.

`teardown.ts` needs no swap. Its job sets `INFISICAL_IDENTITY_ID` and GitHub's OIDC variables, which `CredentialsConfig` reads from `process.env` in-process exactly as the child read them, and GitHub Actions injects no `CLOUDFLARE_API_TOKEN`.

## 4. What reads the cwd

| Fact | Source |
| --- | --- |
| `AlchemyContextLive` (part of `Alchemist.layer()`) creates `path.resolve(".alchemy")` in the cwd. It holds logs, bundle temp dirs and the version-check cache. **(probed: the probe created `.alchemy` in its cwd)** | `alchemy/src/AlchemyContext.ts` lines 35–51; `alchemy/src/Cli/GlobalLog.ts` line 243; `alchemy/src/Bundle/TempRoot.ts` lines 36–64 |
| `localState()` keeps state in `<initialCwd>/.alchemy/state`. `initialCwd` is `process.cwd()` when alchemy's `Util/Node.ts` first loads. Only `dev` and `test` use local state; preview, staging and production use `Cloudflare.state()`. | `alchemy/src/State/LocalState.ts` line 34; `alchemy/src/Util/Node.ts` line 24; `packages/deploy/src/target.ts` lines 63–68 |
| `loadConfigProvider` reads `./.env` relative to the cwd. | `alchemy/src/Util/ConfigProvider.ts` lines 133–135 |
| Bun loads `.env` files from the cwd into `process.env` at startup. With `.env` in the probe's cwd, its value reached the stack through the implicit `ProcessEnv` even though the stack declares `secrets`; `ProcessEnv({ disabled: true })` hid it. **(probed)** | probe, rerun with a `.env` |
| `importStack(main)` resolves `main` with `path.resolve`, so a relative path depends on the cwd. Pass an absolute path, e.g. `resolve(import.meta.dirname, "../../../apps", app, "alchemy.run.ts")`, as `runAlchemy` does for its `cwd` today. | `alchemy/src/Alchemist/Entrypoint.ts` line 28 |
| `Website.Vite` defaults `rootDir` to `initialCwd`, but kumora passes `rootDir: import.meta.dirname`. The build child runs with `cwd: config.rootDir`; the memo hash and workspace hashing resolve against that root. | `cloudflare/src/Workers/Sources/Vite.ts` lines 166–180, 350–351; `cloudflare/src/Workers/ViteChild.ts` line 233; `apps/web/alchemy.run.ts` |

For kumora: the Workers Builds Root directory is `apps/<app>` and the deploy command is `bun ../../packages/deploy/src/deploy.ts <app>` (`docs/runbooks/deploy.md` lines 33–37), so the cwd is the one the CLI had. No `.env` is committed (`.gitignore` has `.env*`). `teardown.ts` runs from the repo root, so its `.alchemy` directory and any `.env` come from there, and destroy never runs the program or Vite.

## The probe

A stack with no resources (`providers: Layer.empty`, `state: Alchemy.inMemoryState()`) whose program records `Config.option(Config.String(key))` for three keys, and whose `secrets` callback returns a list set by the probe. The probe runs `Alchemist.importStack` and `Alchemist.plan({ operation: "deploy", stage: "probe" })` under `Alchemist.layer()` and `Effect.scoped`. `fakeInfisical` is `ConfigProvider.layerAdd(fromEnv({ env: { CLOUDFLARE_API_TOKEN: "cf-from-infisical" } }), { asPrimary: true })`, the same shape `Infisical.Secrets` returns, without the network. The ambient override is `ConfigProvider.layer(fromUnknown({ AMBIENT_ONLY, INFISICAL_TOKEN, CLOUDFLARE_API_TOKEN }))` provided over `Alchemist.layer()`. `process.env.CLOUDFLARE_API_TOKEN` is `cf-from-shell` throughout, except in step 6.

| Step | Setup | Seen in the stack program |
| --- | --- | --- |
| 0 | `import.meta.env === process.env` in Bun | `true` |
| 1 | Ambient override, `secrets: [fakeInfisical]` | CF `cf-from-shell`, `INFISICAL_TOKEN` unset, `AMBIENT_ONLY` unset |
| 2 | Ambient override, no `secrets` option | CF `cf-from-shell`, `AMBIENT_ONLY` unset |
| 3 | `secrets: [fakeInfisical]` (implicit `ProcessEnv` last) | CF `cf-from-shell` |
| 4 | `[fakeInfisical, ProcessEnv({ disabled: true })]` | CF `cf-from-infisical` |
| 5 | `[ProcessEnv(), fakeInfisical]` | CF `cf-from-infisical` |
| 6 | `acquireUseRelease` deletes `process.env.CLOUDFLARE_API_TOKEN` and sets `INFISICAL_TOKEN`, after the imports | CF `cf-from-infisical`, `INFISICAL_TOKEN` `it-from-mutation`; restored afterwards |
| 7 | `Config.String("INFISICAL_TOKEN")` under `CredentialsConfig`, token only in the ambient override | missing |
| 8 | Real `Infisical.Secrets`, `CI=true`, `INFISICAL_API_URL=http://127.0.0.1:9`, token only in the ambient override | fails: "Infisical credentials are missing" |
| 9 | Same, token in `process.env` | logs "using environment variables (INFISICAL_TOKEN, INFISICAL_API_URL)", then fails with a transport error to `127.0.0.1:9` |

Steps 8 and 9 show the real Infisical provider takes its token from `process.env` and ignores the ambient provider. No real credentials or cloud stage were used.

## Open points

- **Library copies.** In-process, `deploy.ts`'s `alchemy/Alchemist` and the app stack's `alchemy` must be the same module instance. In this worktree `packages/deploy`, `apps/web` and `apps/dashboard` resolve to one `alchemy`, one `@alchemy.run/cloudflare` and one `effect` directory. [#106](https://github.com/apinrdw/kumora/issues/106) found a latent `ws` fork that gives `main` two alchemy variants; that fork now becomes load-bearing for deploy, not just for typecheck. Not verified what breaks with two copies.
- **`stack.ts` precedence.** Listing `Secrets.ProcessEnv()` first would fix the Cloudflare token for every entry point, including a local `alchemy deploy`. It changes precedence for every key, so it is a decision, not a refactor. The `INFISICAL_TOKEN` mutation is needed either way.
- **The Decision comment.** The `deploy.ts` Decision moves to the `delete process.env.CLOUDFLARE_API_TOKEN` line. Its wording ("The process environment is alchemy's last secret provider") still holds.
- **Not run:** a real `plan` against Infisical or Cloudflare, and the Vite build child's environment. The child-env claim comes from source only.
