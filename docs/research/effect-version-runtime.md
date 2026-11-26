# Effect version and runtime in TanStack Start on Workers

Research for [#15](https://github.com/apinrdw/kumora/issues/15), child of the map [#10](https://github.com/apinrdw/kumora/issues/10). Sources checked on 2026-11-05.

## Answer

- **Adopt Effect v4.** `effect@4.1.2` is the npm `latest` tag. Alchemy v2 requires v4 as a peer dependency, so v3 is not an option if Alchemy is used.
- **Vendor `Effect-TS/effect` at `main`.** That branch is v4 and has `LLMS.md` at its root. v3 lives on the `v3` branch. `Effect-TS/effect-smol` is retired.
- **Use one `ManagedRuntime` per isolate, at module scope.** Build it from an app `Layer`. It must hold only things that are safe to share between requests. Read the Cloudflare `env` and any per-request I/O inside each request, not when the module loads.
- **Map typed errors to HTTP once, at the edge.** Turn the failure channel into a TanStack `redirect()`, `notFound()`, a thrown `Response`, or `setResponseStatus`. Do it in one bridge helper, not in every server function.
- **Packages:** `effect` only, plus `@effect/vitest` for tests. `@effect/platform`, `@effect/rpc` and `@effect/schema` are now part of `effect` (`effect/http`, `effect/rpc`, `effect/Schema`). All Effect packages share one version number.

## 1. Which Effect major

| Fact                                                                                                                                                                                                                                                                                                                                          | Source                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm dist-tags: `latest` 4.1.2 (published 2026-11-02), `prev` 3.22.4. v3 still gets patches (3.22.4 came out 2026-10-22).                                                                                                                                                                                                                      | `npm view effect dist-tags time`                                                                                                                              |
| `alchemy@2.0.0-beta.85` (the npm `latest` tag) has the peer dependencies `effect ^4.1.0`, `@effect/platform-bun ^4.1.0` and `@effect/platform-node ^4.1.0`.                                                                                                                                                                                   | `npm view alchemy@latest peerDependencies`; [`packages/alchemy/package.json`](https://github.com/alchemy-run/alchemy/blob/main/packages/alchemy/package.json) |
| Alchemy's workspace catalog pins `effect: 4.1.0` and `@effect/vitest ^4.1.0`.                                                                                                                                                                                                                                                                 | [`pnpm-workspace.yaml`](https://github.com/alchemy-run/alchemy/blob/main/pnpm-workspace.yaml)                                                                 |
| v4: "All Effect ecosystem packages now share a single version number and are released together." `@effect/platform`, `@effect/rpc` and `@effect/cluster` are merged into `effect`. The packages that stay separate are `@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*`, `@effect/opentelemetry`, `@effect/atom-*` and `@effect/vitest`. | [`MIGRATION.md`](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md) § Versioning, § Package Consolidation                                            |
| Modules such as `http`, `http-api`, `rpc`, `schema`, `sql` and `workers` are imported as `effect/<module>` but are marked `@stability unstable`: they can break in minor releases.                                                                                                                                                            | `MIGRATION.md` § Unstable Module System                                                                                                                       |

Conclusion: adopt v4. Pin the `effect` version exactly, or at least to a minor (`~4.1.x`), because the `http` and `rpc` modules that server code uses may break in minor releases.

## 2. Which repo and branch to vendor

| Fact                                                                                                                                                                                                                                                                                                               | Source                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Effect-TS/effect` has default branch `main`. `packages/effect/package.json` on `main` has version `4.1.2`. The root has `LLMS.md` (433 lines), `MIGRATION.md` and `ai-docs/`, and LLMS.md links into `ai-docs/src/**`.                                                                                            | `gh api repos/Effect-TS/effect/contents`                                                                                                      |
| The `effect-smol` README: "Effect V4 Has Moved. This repository is archived and read-only… V4 (`main`), V3 (`v3`)".                                                                                                                                                                                                | [`Effect-TS/effect-smol` README](https://github.com/Effect-TS/effect-smol)                                                                    |
| The blog post uses `git subtree add --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash` (and the matching `pull`). It also says: "If you've created a subtree for Effect v4, you can also explicitly tell the agent to always read @repos/effect/LLMS.md before writing any Effect code." | [effect.website blog](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive) (last updated 2026-05-11) |
| `LLMS.md` opens: "use this documentation and the Effect source code available in your environment. Avoid unrelated copies of Effect or external documentation, as they may be outdated."                                                                                                                           | `LLMS.md` lines 1–10                                                                                                                          |
| Alchemy repo: `alchemy-run/alchemy`, default branch `main` (package `alchemy@2.0.0-beta.85`). It has `AGENTS.md`, `CLAUDE.md`, `examples/` and `website/src/content/docs/`.                                                                                                                                        | `gh repo view alchemy-run/alchemy`                                                                                                            |

Vendoring `main` follows the latest release line, not the version installed from npm. Tracking a release tag instead (for example `effect@4.1.2`) keeps the vendored source matched to `package.json`. That choice is for the "Vendored-repo upkeep" item on the map.

## 3. Running Effect inside TanStack Start on a Worker

### What the primary sources show

**Effect's own recommendation** (LLMS.md § "Integrating Effect into existing applications", [`ai-docs/src/04_integration/10_managed-runtime.ts`](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/04_integration/10_managed-runtime.ts)):

> "Build one runtime from your application Layer, then use it anywhere you need imperative execution, like web handlers, framework hooks…"

The example builds `ManagedRuntime.make(AppLayer, { memoMap })` once at module scope with a shared `Layer.makeMemoMapUnsafe()`. Each handler calls `runtime.runPromise(...)`. Typed errors are caught with `Effect.catchTag` and turned into HTTP statuses at the handler. `Schema.decodeUnknownSync` validates the request body at the edge. The example also calls `runtime.dispose()` on `SIGTERM`, which has no Workers equivalent; isolates are evicted without a hook.

**Alchemy's Effect-native Worker** ([`infrastructure-as-effects/runtime.mdx`](https://github.com/alchemy-run/alchemy/blob/main/website/src/content/docs/infrastructure-as-effects/runtime.mdx), [`phases.mdx`](https://github.com/alchemy-run/alchemy/blob/main/website/src/content/docs/infrastructure-as-effects/phases.mdx)):

- In `Cloudflare.Worker("Api", { main }, Effect.gen(...))`, the outer Effect is the **Construction phase**. It runs at plan time, to record bindings, and again "at most once per cold start". The inner `fetch` Effect runs once per request.
- Bindings are typed Effect clients: `yield* Cloudflare.R2.ReadWriteBucket(Uploads)` gives a client, provided by `Cloudflare.R2.ReadWriteBucketBinding`. Your own services come in as Layers through `Effect.provide(...)`.
- This is the per-isolate runtime pattern, but Alchemy wires it for you. It covers **plain Workers only**, not TanStack Start apps.

**Alchemy with TanStack Start** ([`cloudflare/frontend/tanstack-start.mdx`](https://github.com/alchemy-run/alchemy/blob/main/website/src/content/docs/cloudflare/frontend/tanstack-start.mdx), [`examples/cloudflare-tanstack-rpc-drizzle`](https://github.com/alchemy-run/alchemy/tree/main/examples/cloudflare-tanstack-rpc-drizzle)):

- You deploy the app with `Cloudflare.Website.Vite("Website", { env: {...} })`. Bindings are native Worker bindings, typed by `Cloudflare.InferEnv<typeof Website>` and added to `cloudflare:workers` through `src/env.d.ts`.
- Server code reads `env` through a `Proxy` over `cf.env`, because "TanStack Start's dev server evaluates route modules outside the Worker request context, so a top-level `import { env } from "cloudflare:workers"` breaks in dev".
- **Alchemy's own full-stack example keeps the TanStack worker free of Effect.** The `/rpc` server route only proxies `env.BACKEND.fetch(request)`. All Effect code runs in a separate `Cloudflare.Workers.RpcWorker` with `RpcServer.toHttpEffect(TodoRpcs)`, reached through a private service binding (`workersDev: false`). The example deploys with `bun alchemy deploy`.
- Alchemy is "not compatible with `@cloudflare/vite-plugin`". Both `apps/web/vite.config.ts` and `apps/dashboard` use it today.

**TanStack Start hooks** (TanStack/router `docs/start/framework/react/guide/`):

- [`server-functions.md`](https://github.com/TanStack/router/blob/main/docs/start/framework/react/guide/server-functions.md): `createServerFn().validator(schema).handler(...)`. Handlers may throw `redirect()`, `notFound()` or a `Response`. `getRequest()` and `setResponseStatus()` come from `@tanstack/react-start/server`.
- `.validator` accepts any Standard Schema: `packages/router-core/src/validators.ts` defines `StandardSchemaValidator` with `'~standard'`. Effect v4 has `Schema.toStandardSchemaV1(schema)` (`packages/effect/src/Schema.ts`, `@since 4.0.0`), so Effect Schema can be passed to `.validator` directly.
- [`middleware.md`](https://github.com/TanStack/router/blob/main/docs/start/framework/react/guide/middleware.md): `createMiddleware({ type: 'function' }).server(({ next }) => next({ context }))` passes typed context down the chain. Global middleware is registered through `createStart(() => ({ requestMiddleware, functionMiddleware }))`.
- [`server-entry-point.md`](https://github.com/TanStack/router/blob/main/docs/start/framework/react/guide/server-entry-point.md): a custom `src/server.ts` uses `createServerEntry({ fetch(request, opts) { return handler.fetch(request, { ...opts, context }) } })`. A typed `server.requestContext` is registered on `Register` and is "available throughout the server-side middleware chain — including … server functions". Errors that escape become a generic 500 JSON response unless a response helper or a thrown `Response` sets the status.

**Cloudflare constraints** ([Bindings docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/)):

- "Workers do not allow I/O from outside a request context." At module scope you can read secrets and vars from `env`, but binding I/O fails there.
- Be "careful when 'polluting' global scope with derivatives of your bindings". The page recommends creating clients per request.

### Recommended pattern, derived from the sources above

No source shows Effect _inside_ TanStack Start server functions on Workers. This combines the patterns above:

1. **Runtime per isolate.** In a server-only module, write `const runtime = ManagedRuntime.make(AppLayer)` at module scope. Layers in it must be stateless or safe to share between requests: config, loggers, pure services. Layer construction must not do binding I/O, because the runtime builds lazily on the first `run*` call. That call happens inside a request, but a resource opened then would be reused by later requests, which Cloudflare forbids for I/O objects. The source docs confirm the lazy build: "The layer is built lazily on first use and its context is cached". They also say "A failed layer build is also cached", so one failed build breaks every later request on that isolate (`packages/effect/src/ManagedRuntime.ts`, `make`).
2. **`env` and request as per-request services.** Define `class WorkerEnv extends Context.Service<WorkerEnv, Env>()("WorkerEnv")`, plus a similar `CurrentRequest`. Provide them on each call: `runtime.runPromise(effect.pipe(Effect.provideService(WorkerEnv, env)))`. Use the Alchemy `Proxy`, or `cf.env` read inside the handler, to get `env`. Per-request clients, such as a DB connection through Hyperdrive, go in a request-scoped `Layer` provided in the same way.
3. **One bridge helper**, for example `runServerEffect(effect)`. It runs the effect with `runPromiseExit`, then matches the `Exit`: a tagged `NotFound` becomes `throw notFound()`, `Unauthorized` becomes `throw redirect(...)`, a domain error becomes `setResponseStatus(4xx)` plus an encoded body or a thrown `Response`. A defect is rethrown, and Start's entry turns it into a 500. Server functions then read `createServerFn().validator(Schema.toStandardSchemaV1(Input)).handler(({ data }) => runServerEffect(program(data)))`.
4. **Or follow Alchemy's split.** Keep the TanStack worker thin and put Effect in a separate `Cloudflare.Worker` or `RpcWorker`, reached through a service binding. Bindings then arrive as Alchemy's typed Effect clients and no `ManagedRuntime` bridge is needed. The cost is a second Worker per app.

## 4. Upstream packages that matter

| Package                                             | Role for kumora                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `effect`                                            | Everything: core, `Schema`, `ManagedRuntime`, `effect/http`, `effect/rpc`, `effect/http-api`.                                                                                  |
| `@effect/vitest`                                    | `it.effect` and layer-based tests ([LLMS.md § Testing](https://github.com/Effect-TS/effect/blob/main/LLMS.md), `ai-docs/src/09_testing/`). Needs the same version as `effect`. |
| `@effect/platform-bun` / `@effect/platform-node`    | Peer dependencies of `alchemy` for the deploy program, which runs on Bun per the map. The Worker code does not need them.                                                      |
| `@effect/schema`, `@effect/platform`, `@effect/rpc` | Do not install: these are v3-era packages now inside `effect`.                                                                                                                 |
| `@effect/opentelemetry`                             | Optional. LLMS.md recommends `effect/observability` Otlp modules for new projects.                                                                                             |

## Open questions for a grilling ticket

1. **Where Effect runs:** inside the TanStack Start worker through a `ManagedRuntime` bridge (§3 option 1–3), or in a separate Alchemy Effect-native Worker behind a service binding (option 4, Alchemy's own example)?
2. **Subtree tracking:** `main`, which follows the latest release, or a release tag that matches the pinned `effect` version? What is the pull cadence?
3. **Version pin policy:** exact (`4.1.2`) or `~4.1`? The `http` and `rpc` modules are `@stability unstable`, and Alchemy v2 is still in beta (`2.0.0-beta.85`).
4. **Error-to-HTTP contract:** which tagged errors map to `redirect`, `notFound` or status codes, and is the bridge helper's shape a coding standard?
5. **`@cloudflare/vite-plugin` removal:** both apps use it with `wrangler` today, and Alchemy forbids it. This is linked to the map's "CI and checks" item (`wrangler types --check`).
