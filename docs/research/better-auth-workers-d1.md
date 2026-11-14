# Better Auth on the dashboard Worker with D1, TanStack Start and Alchemy

Research for [How Better Auth runs on the dashboard Worker with D1, TanStack Start and Alchemy](https://github.com/apinrdw/kumora/issues/66) (map: [Sign in to the dashboard with Better Auth on D1](https://github.com/apinrdw/kumora/issues/63)). Researched 2026-11-07.

Sources:

- **Better Auth**: [`better-auth/better-auth`](https://github.com/better-auth/better-auth) at commit `ba59f5d8ecec4741718dc6d16ca135d810a1bef0` (2026-11-06), package version `1.7.18`, which is npm `latest` on 2026-11-07 (`npm view better-auth dist-tags`). `docs/content/docs/` in that repo is the source of [better-auth.com/docs](https://better-auth.com/docs). Below, `BA:` means a path in that repo.
- **Alchemy**: the vendored `repos/alchemy` (2.0.0-beta.85, the catalog version). `AL:` means a path under `repos/alchemy`.
- **`@better-auth/utils` 0.5.1**: the npm tarball, read for the password hasher.
- **Cloudflare**: the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [`node:crypto`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/) and [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) pages, read 2026-11-07.
- **TanStack Start**: the [server entry point](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point) and [middleware](https://tanstack.com/start/latest/docs/framework/react/guide/middleware) guides.

## Answer

- **Adapter: none extra.** Better Auth 1.7 ships its own D1 dialect inside the built-in Kysely adapter. Pass the Worker's `D1Database` binding as `database`. Drizzle and `kysely-d1` add nothing here. The only cost is that D1 has no interactive transactions.
- **Two ways to host it.**
  - **(A) Plain `better-auth` inside the TanStack Start Worker.** The D1 binding comes from `env` on `Cloudflare.Website.Vite`. The schema is checked-in SQL files, applied by `Cloudflare.D1.Database("AuthDb", { migrations })` on every deploy and in `alchemy dev`.
  - **(B) Alchemy's `@alchemy.run/better-auth` in a separate Effect-native auth Worker.** The dashboard forwards `/api/auth/*` to it over a service binding. This gives automatic deploy-time migrations and a managed secret.

  `Website.Vite` takes no Effect implementation, so it cannot host `@alchemy.run/better-auth` directly.
- **Recommend (A).** It keeps one Worker per stage, keeps the session check in-process for route loaders, server functions and the Durable Object upgrade, and keeps the client's plugin type inference. The cost is generating migration SQL by script.
- **TanStack Start.** Mount `auth.handler` in the splat server route `src/routes/api/auth/$.ts`. Read the session with `auth.api.getSession({ headers })`. Use one global request middleware in `src/start.ts`, or a `_protected` layout `beforeLoad` that calls a server function.
- **Admin plugin.** It covers roles, ban/unban (ban also deletes sessions), revoke one session, revoke all sessions, and list users. The `member` role needs custom access control, because without it only `admin` and `user` are valid roles. A `databaseHooks.user.create.before` hook can set `role: "admin"` from a config email list. A `hooks.before` on `/admin/set-role` can refuse to demote listed admins.
- **Session cost.** Turn on `session.cookieCache`. While its signed `session_data` cookie is valid, `getSession`, and so every page load and websocket upgrade, needs no D1 read. The trade-off: a ban, revoke or role change takes effect only when the cache expires (`maxAge`). Admin-plugin endpoints always bypass the cache.
- **Rate limits.** The default storage is in-memory, which is per isolate and useless on Workers. Use `storage: "database"`, a `rateLimit` table in the same D1. The alternative is `customStorage`, backed by the Workers Rate Limiting binding or a Durable Object. Set `enabled: true` and `ipAddressHeaders: ["cf-connecting-ip"]` explicitly.
- **Workers gotchas.**
  - Password hashing is scrypt (N=16384, r=16) through workerd's native `node:crypto`, which needs `nodejs_compat` (already on). That fits the Paid plan's 30 s CPU default but not the Free plan's 10 ms.
  - Pass `waitUntil` as `advanced.backgroundTasks.handler`.
  - Don't read `env` at module top level under the TanStack Start dev server.
  - Effect stays in `alchemy.run.ts`, because the dashboard's runtime code has no Effect today.

## Findings

### 1. Database adapter

- **Built-in D1 dialect.** `options.database` accepts a `D1Database` directly (`BA:packages/core/src/types/init-options.ts:633`). The Kysely adapter detects it and loads its own `D1SqliteDialect` and index introspector (`BA:packages/kysely-adapter/src/dialect.ts:184-193`, `BA:packages/kysely-adapter/src/d1-sqlite-dialect.ts`). The docs list `aidenwallis/kysely-d1` only as a community dialect (`BA:docs/content/docs/adapters/other-relational-databases.mdx:27`). It is not needed.
- **No transactions.** The dialect comment says "D1 has no interactive transactions; only its batch() API" (`dialect.ts:193`). Consequences, from the docs:
  - Password reset and password change are not atomic on D1. If saving the new password fails, the reset token is already spent and the sessions are already revoked, and the old password stays in place (`BA:docs/content/docs/authentication/email-password.mdx:398-402`; `BA:docs/content/docs/concepts/session-management.mdx:212`).
  - SCIM in 1.7 cannot run on D1 (`BA:docs/content/docs/guides/1-7-upgrade-guide.mdx:566`; `AL:website/src/content/docs/better-auth/databases/cloudflare-d1.mdx`, "Transaction and migration limits").

  Neither matters for the map's feature set.
- **Drizzle.** It would only help if the dashboard also wanted a typed ORM over the same D1. Better Auth's own docs point D1 + Drizzle users to drizzle-kit (`BA:docs/content/docs/concepts/database.mdx:118-121`). Nothing in the map needs that.

### 2. Hosting: where the Better Auth instance lives

**What Alchemy offers.** `@alchemy.run/better-auth` (`AL:packages/better-auth`, same version as the catalog) is an Effect wrapper:

- `yield* BetterAuth(options)` inside a Worker's implementation Effect, with `Effect.provide(CloudflareD1(AuthDb))`.
- It provisions a stable `Alchemy.Random` signing secret when `secret` is omitted (`AL:packages/better-auth/src/BetterAuth.ts:155-158`).
- It registers a deploy-time Action that runs Better Auth's `getMigrations` over the D1 HTTP API, or against the local simulator under `alchemy dev`. The Action reruns only when the schema fingerprint or the database identity changes (`AL:packages/better-auth/src/Migrate.ts`, `AL:packages/better-auth/src/CloudflareD1.ts:67-116`, `AL:website/src/content/docs/better-auth/guides/migrations.mdx`).
- It creates one Better Auth instance per execution (`BetterAuth.ts:179-220`).

**Why it does not fit `Website.Vite` directly.** `Website.Vite` takes only `(id, props)`, with no implementation Effect (`AL:packages/cloudflare/src/Website/Vite.ts:251-258`). Its Worker entry is TanStack Start's SSR bundle, not an Alchemy Effect Worker. So the wrapper cannot be yielded inside the dashboard Worker.

**Alchemy's own frontend pattern.** It pairs a frontend with the wrapper as two Workers. `AL:examples/cloudflare-domain-better-auth/alchemy.run.ts` puts a Foldkit site in front of an Effect `NotesWorker`. It forwards `/api/*` over a service binding with `runWorkerFirst`, "so the session cookie is first-party" (`src/web/worker.ts`). `AL:examples/cloudflare-tanstack-rpc-drizzle` does the same for TanStack Start: a `/rpc` server route calls `env.BACKEND.fetch(request)`.

**Option (A): plain `better-auth` in the dashboard Worker.**

- Declare `const AuthDb = Cloudflare.D1.Database("AuthDb", { migrations: "./migrations" })` and bind it with `env: { AUTH_DB: AuthDb }` on the existing `Website` in `apps/dashboard/alchemy.run.ts`. `InferEnv` maps a D1 resource to `D1Database` (`AL:packages/cloudflare/src/Workers/InferEnv.ts:101-102`). `AL:examples/cloudflare-worker-async/alchemy.run.ts` shows the same `env` binding.
- Better Auth runs in the same isolate as SSR, server functions and the Market Live Durable Object. The upgrade check is a direct `auth.api.getSession({ headers: request.headers })` call.
- **Migrations.**
  - The D1 resource applies `.sql` files in numeric-prefix order on every deploy and records them in `__alchemy_migrations` (`AL:website/src/content/docs/cloudflare/data/d1.mdx`, "Migrations"; `AL:packages/cloudflare/src/D1/Database.ts:81-95, 505-551`). The local provider runs the same pipeline under `alchemy dev` (`Database.ts:569-660`).
  - The SQL comes from `npx auth@1.7.x generate`. For the Kysely adapter, it "will generate an SQL file you can run directly on your database". However, Kysely generation "still requires the configured database": it introspects a live database and emits the difference (`BA:docs/content/docs/concepts/cli.mdx`, "Generate"). The CLI cannot reach D1 (`BA:docs/content/docs/concepts/database.mdx:68`).
  - So the generator needs a CLI-only config. It uses the same options and plugins as the runtime config, with a local SQLite database. A script replays `migrations/*.sql` into a scratch SQLite file and then runs `auth generate --output migrations/000N_<name>.sql`. CI can rerun the script and fail when it emits a non-empty file. That makes the check a drift lint for plugin or option changes that lack a migration.
  - Run `npx auth check schema` against the scratch database as a second guard.
- **Secret.** Without Alchemy's managed secret, `BETTER_AUTH_SECRET` comes from Infisical per stage (see 'How auth is configured on each stage and in local dev'). Alternatively, the stack can create an `Alchemy.Random` and bind it as a secret. The deploy page documents the wrapper doing exactly that (`BetterAuth.ts:155-158`).

**Option (B): Alchemy's wrapper in a separate auth Worker.** You get automatic, fingerprinted migrations and a managed secret. The costs:

- Two Workers per stage.
- Every SSR and server-function session read is a service-binding round trip, and so is the Durable Object upgrade check.
- The browser client's plugin types (`adminClient`, `inferAdditionalFields`) must be wired to a config that lives in another package.
- The schema is still migrated additively only. Alchemy's docs say automatic migrations are "not a data-transfer or destructive schema-migration tool" (`cloudflare-d1.mdx`).

**Not recommended: a hybrid.** You could call the wrapper's `BetterAuth()` in `alchemy.run.ts` only for its migration Action and secret, and run plain `better-auth` in the Worker. That relies on the internal `registerMigration` and on the secret being bound "into the host environment". The package marks `Migrate.ts` `@internal`.

### 3. TanStack Start: handler and session reads

- **Handler.** Create `src/routes/api/auth/$.ts` with `server.handlers.GET` and `POST`, each returning `auth.handler(request)` (`BA:docs/content/docs/integrations/tanstack.mdx`, "Mount the handler").
- **Cookies from server-side calls.** Add `tanstackStartCookies()` from `better-auth/tanstack-start` as the **last** plugin. Without it, `auth.api.signInEmail` and similar calls inside server functions do not set cookies (same page, "Usage tips"). The docs recommend the browser `authClient` for sign-in flows anyway.
- **Reading the session.**
  - Use `createServerFn` + `getRequestHeaders()` + `auth.api.getSession({ headers })`.
  - Call it from `beforeLoad` on a pathless `_protected` layout, so client-side `<Link>` navigation is checked too. Redirect to `/login` with `search: { redirect }` (same page, "Protecting Resources").
  - Server functions call an `ensureSession` helper.
  - For "the whole dashboard", a global request middleware is the alternative. `src/start.ts` → `createStart(() => ({ requestMiddleware: [authMiddleware] }))` runs "before every request, including server routes, SSR and server functions". It passes `next({ context: { session } })` downstream ([middleware guide](https://tanstack.com/start/latest/docs/framework/react/guide/middleware)).
  - That middleware must let `/api/auth/*`, the sign-in pages and the extension's ingest path through.
- **Durable Object export.** A custom `src/server.ts` can export Durable Object classes beside the Start handler ([server entry guide](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point)). `Website.Vite` takes `main` for such an entry (`Vite.ts`, "Custom Worker Entry"). Market Live's work already sets up the Durable Object, so the upgrade check sits in that same `fetch` before `stub.fetch`.
- **Reading `env`.** Top-level `import { env } from "cloudflare:workers"` breaks under the TanStack Start dev server, because route modules evaluate outside a request. Read `env` lazily, for example by building `auth` on first use (`AL:website/src/content/docs/cloudflare/frontend/tanstack-start.mdx`, "Read bindings in server code"; `AL:examples/cloudflare-website-tanstack-start/src/env.ts`).
- **Static assets bypass the Worker.** Static assets are served before the Worker unless `runWorkerFirst` routes them through it, so any prerendered page would bypass the gate. The dashboard has no `prerender` today (`apps/dashboard/vite.config.ts`). Keep it that way for gated routes. Files in `public/` stay public.

### 4. Admin plugin: roles, ban, revoke, admin email list

- **What it covers.** `admin()` adds `role`, `banned`, `banReason` and `banExpires` to `user`, and `impersonatedBy` to `session` (`BA:docs/content/docs/plugins/admin.mdx`, "Schema"). It also adds these endpoints:
  - `set-role`
  - `ban-user`: "preventing them from signing in and revokes all of their existing sessions" (admin.mdx:300). The code calls `deleteUserSessions` (`BA:packages/better-auth/src/plugins/admin/routes.ts:710`).
  - `unban-user`
  - `list-user-sessions`
  - `revoke-user-session`
  - `revoke-user-sessions`
  - `list-users`, with filters and pagination
  - `remove-user`
  - `impersonate-user`

  A `session.create.before` hook refuses new sessions for banned users and lifts expired bans (`BA:packages/better-auth/src/plugins/admin/admin.ts:90-122`).
- **The `member` role.** By default, new users get `defaultRole` (`"user"`). "When not using custom access control, only `admin` and `user` exist as valid roles" (admin.mdx:795).
  - For admin and member, define `createAccessControl` roles `{ admin, member }`, built from `adminAc` and `userAc`, and set `defaultRole: "member"`.
  - With `roles` set, `set-role` rejects unknown roles (`routes.ts:146-157`).
  - Turn off impersonation if it's unwanted. The owner did not list it. Leave `impersonate` out of the admin role's statements.
- **Admin email list on creation.** Use `databaseHooks.user.create.before: (user) => ({ data: { ...user, role: list.has(normalize(user.email)) ? "admin" : "member" } })`.
  - User hooks run before plugin hooks (`BA:packages/better-auth/src/context/create-context.ts:388-389`).
  - The admin plugin's own hook spreads `...user` over its default role, so the hook's role survives (`admin.ts:80-86`).
  - Covered by tests? No. Confirm it with a test during implementation.
- **"Listed admins can't be demoted."** This isn't a plugin option. Add `hooks.before` with `createAuthMiddleware`. On `ctx.path === "/admin/set-role"`, look up the target user and throw `APIError("FORBIDDEN")` if their email is listed. Ban and remove-user probably deserve the same guard. The owner hasn't said.
- **Bootstrapping.** `npx auth create-admin` exists (`BA:docs/content/docs/concepts/cli.mdx`, "Create Admin"). It needs a CLI-reachable database, so it can't target D1. The email-list hook removes the need for it.

### 5. Session cost per request

- **Without the cookie cache.** `getSession` looks up the `session_token` row and its user in the database. Joins are off by default, so the adapter uses separate queries (`BA:docs/content/docs/reference/options.mdx:692`). It also writes a refreshed `expiresAt` once per `updateAge`, which defaults to 1 day (`BA:docs/content/docs/concepts/session-management.mdx`, "Session Expiration").
- **With `session.cookieCache: { enabled: true, maxAge }`.** Better Auth also sets a signed `session_data` cookie. "The server can check session validity from the cookie itself instead of hitting the database each time" (session-management.mdx:216-231; code path `BA:packages/better-auth/src/api/routes/session.ts:87-140`). Page loads and Durable Object upgrades within `maxAge` cost no D1 read. That includes `auth.api.getSession({ headers })` on the upgrade request, which carries the same cookies.
- **Staleness.** "Revoked sessions may remain active on other devices until the cookie cache expires" (session-management.mdx:240-250). The same applies to a ban, because it deletes sessions, and to a role change, because the cached user carries `role`.
  - Admin-plugin endpoints always call `getAuthoritativeSessionFromCtx`, which passes `disableCookieCache: true` (`routes.ts:37-38`; `session.ts:528-540`).
  - The app's own admin-only pages should call `getSession({ headers, query: { disableCookieCache: true } })`.
  - Choose `maxAge` (e.g. 5 minutes) as the accepted revocation delay. The websocket check runs on upgrade only, so an open socket outlives any revocation regardless.
- **Encoding.** `strategy`: `compact` is the default and the smallest. `jwt` and `jwe` are the alternatives (session-management.mdx:255-288).

### 6. Built-in rate limiting on Workers

- **Defaults.** Enabled when `isProduction`, with a 10 s window and 100 requests (`BA:docs/content/docs/concepts/rate-limit.mdx`; `create-context.ts:359`). `isProduction` derives from `NODE_ENV`, so set `rateLimit.enabled: true` explicitly rather than trusting the bundle's `NODE_ENV`.
- **Storage options** (rate-limit.mdx, "Storage"):
  - **Memory (default).** Per isolate. Workers spread requests over many isolates, so the counters mean nothing.
  - **`storage: "database"`.** Adds a `rateLimit` table to the schema, so it lands in the generated migration. It costs a D1 read and write per rate-limited auth request. That's fine for the dashboard's auth traffic.
  - **`secondary-storage`.** Needs a `secondaryStorage`. Alchemy's guide says Cloudflare KV "does not satisfy this contract" because it is eventually consistent, and `increment` must be atomic (`AL:website/src/content/docs/better-auth/guides/secondary-storage.mdx`). Skip it.
  - **`customStorage.consume(key, rule)`.** Could call the Workers Rate Limiting binding. That binding is per Cloudflare location, eventually consistent, and limited to a `period` of 10 or 60 s, and Cloudflare recommends Durable Objects for a strict limit ([Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). Alchemy has the binding as `Workers/RateLimit.ts`.
- **Client IP.** By default Better Auth reads `X-Forwarded-For`, which clients can forge. On Cloudflare, set `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]` (rate-limit.mdx, "Connecting IP Address").
- **What is not covered.** The limiter protects Better Auth's routes only. The question of limits per sign-up, sign-in and email send belongs to 'Whether open sign-up needs bot protection and rate limits'.

### 7. Workers runtime gotchas and Effect

- **Password hashing.** `@better-auth/utils/password` maps the `workerd` export condition to `password.node.mjs`. That module calls `node:crypto` `scrypt` with N=16384, r=16, p=1, dkLen=64, which takes about 32 MB of memory (tarball `dist/password.node.mjs`; source comment at `BA:packages/better-auth/src/crypto/password.ts:1-6`).
  - Workers support "all `node:crypto` APIs" except a short list that excludes scrypt. Only argon2 is called out ([node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)). That needs `nodejs_compat`, which `websiteProps` already sets (`packages/deploy/src/stack.ts`).
  - CPU per request: Free is "10 ms". Paid is "5 min (default: 30 seconds)". Memory is 128 MB per isolate ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
  - One scrypt at these parameters is tens of milliseconds of CPU, which breaks the Free plan's limit on every sign-up and sign-in. That is an estimate, not measured here. On Paid it is fine. `emailAndPassword.password.{hash,verify}` can swap the hasher, but then existing hashes would need a migration path.
- **Background work.** Better Auth does fire-and-forget work. Set `advanced.backgroundTasks.handler: (p) => waitUntil(p)` with `waitUntil` from `cloudflare:workers` (`BA:docs/content/docs/reference/options.mdx:713-738`). Alchemy's wrapper does the equivalent with an execution-scope finalizer (`BetterAuth.ts:185-189`).
- **Schema validation.** It runs at instance init and reads the schema from the database. The default is `true` outside production (options.mdx:693). Set `advanced.database.validateSchema: false` on deployed stages, or rely on a module-scope singleton so it runs once per isolate.
- **Duplicate packages.** Two copies of `better-auth` or `@better-auth/core` in the tree break plugins, "especially in Cloudflare Workers" (`BA:docs/content/docs/reference/faq.mdx:138`). Pin one version in the `pnpm-workspace.yaml` catalog.
- **Bundle size.** The Workers limits page says 64 MiB uncompressed and "There is no compressed size limit", so Better Auth's size is not a constraint. The dashboard bundle was not measured here.
- **Effect.**
  - The dashboard's runtime code imports no Effect today (`grep "from \"effect" apps/dashboard/src` finds nothing). Effect lives in `alchemy.run.ts`.
  - Under (A), Better Auth stays Promise-based inside server routes and functions. Where Effect code needs the session, wrap the call in `Effect.tryPromise` into a `Context.Service` per `repos/effect/LLMS.md` ("Integrating Effect into existing applications", "Writing Effect services").
  - Better Auth's own Effect page mounts `auth.handler` with `HttpEffect.fromWebHandler` for Effect HTTP servers (`BA:docs/content/docs/integrations/effect.mdx`). That only matters if (B) is chosen.

## Open

- **Workers plan.** Is the account on Workers Paid? The Durable Object cost research priced Paid, but nothing in the repo states the plan. The Free plan's 10 ms CPU limit rules out the default scrypt.
- **Squatting a listed admin email.** Someone can sign up first with a listed admin email. With `requireEmailVerification` they can't sign in, but the row exists with `role: "admin"`, and the real owner's sign-up returns a fake success (`email-password.mdx:175`). Options: grant admin on verification instead of creation (a `user.update` hook when `emailVerified` flips), or recover through password reset. Decide in the spec.
- **Generator script.** The exact shape of the migration-generator script under (A), and whether to commit `auth.cli.ts`. That is implementation detail for the spec.
- **Cookie cache length.** The `maxAge` value, which is the accepted revocation delay, should be settled alongside 'Session length and "remember me"' on the map.
