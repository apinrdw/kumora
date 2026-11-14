# Alchemy and a TanStack Start app on Cloudflare

Research for [#11](https://github.com/apinrdw/kumora/issues/11) (map [#10](https://github.com/apinrdw/kumora/issues/10)). Researched 2026-11-05.

Sources: the Alchemy repo [`alchemy-run/alchemy`](https://github.com/alchemy-run/alchemy) at commit `5bbe9aa4d8ea8975b47e488239c04afd68f2d54c` (2026-11-04), whose `website/src/content/docs/` is the source of [alchemy.run](https://alchemy.run/cloudflare/). On npm, `alchemy` and `@alchemy.run/cloudflare` were both `latest: 2.0.0-beta.85` on 2026-11-05 (`npm view alchemy dist-tags`). Paths below are relative to that repo at that commit. Alchemy is in beta, so re-check these facts before the spec is frozen.

## Answer

- **Resource.** Each app is one `Cloudflare.Website.Vite(id, props)` yielded from an `Alchemy.Stack` in `alchemy.run.ts`. Alchemy runs the app's own `vite.config.ts` through `vite.createBuilder().buildApp()`, with Alchemy's Cloudflare plugin appended. The SSR bundle becomes the Worker entry and the client build is uploaded as Worker static assets. The resource has no `main`, no build command, no output directory and no `wrangler.jsonc`.
- **Bindings.** Bindings go in `env` on the resource. Keys prefixed `VITE_` are inlined into the client at build time. Every other key becomes a runtime Worker binding, typed with `Cloudflare.InferEnv<typeof Website>`.
- **What it replaces.** It replaces `wrangler.jsonc`, `wrangler types` with its `worker-configuration.d.ts`, and `@cloudflare/vite-plugin`. The docs say to remove `@cloudflare/vite-plugin` because the two plugins are incompatible.
- **Local dev.** `vite dev` is replaced by `alchemy dev`. That command starts Vite's dev server itself, with Alchemy's plugin attached, and runs the SSR code in workerd with HMR.
- **Monorepo.** One Stack can own both apps. Root `alchemy.run.ts`, one `Website.Vite` per app, each with `rootDir` anchored via `import.meta.dirname`. The docs also cover one Stack per package.
- **Bun.** Optional. Node 22.22.3+ or 24.11.1+ also works. The docs use `bun alchemy …` throughout.

## Findings

### 1. Resource and binding shape in `alchemy.run.ts`

- **Declaration.** The TanStack Start page declares the site as a module-level const and adds it to a Stack:

  ```ts
  export const Website = Cloudflare.Website.Vite("Website", {
    env: { BUCKET: Bucket, BACKEND: Backend },
  });
  export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

  export default Alchemy.Stack(
    "CloudflareTanstackExample",
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const website = yield* Website;
      return { websiteUrl: website.url.as<string>() };
    }),
  );
  ```

  Sources: `website/src/content/docs/cloudflare/frontend/tanstack-start.mdx` ("Declare the Website", line 68, and "Add it to the Stack"). The example at `examples/cloudflare-website-tanstack-start/alchemy.run.ts` uses the class form, `class Website extends Cloudflare.Website.Vite<Website>()("Website", {...}) {}`. The class form is needed only when another resource binds to the site (`cloudflare/frontend/vite.mdx`, "Props").
- **Build.** A deploy loads the project's own Vite install, calls `vite.createBuilder({ root: rootDir, define: getDefine(env), plugins: [cloudflare(pluginOptions), …] })` and then `builder.buildApp()`. The client output becomes Worker static assets and the SSR bundle becomes the entry. There is no `main` and no `wrangler.jsonc`. Sources: `cloudflare/frontend/vite.mdx` ("One resource, one build", lines 20–35; "What pure Vite means") and `packages/cloudflare/src/Website/Vite.ts` (JSDoc, line 29: "no manual `main` entrypoint, build command, output directory, or Wrangler configuration required").
- **Props.** `ViteProps` is `WorkerProps` minus `main`, `assets`, `rules` and `vite`, plus the Vite options `rootDir`, `memo`, `viteEnvironments`, a flat `assets` routing config and `dev.port`. Source: `packages/cloudflare/src/Website/Vite.ts:15-22`. These `WorkerProps` fields cover today's `wrangler.jsonc` keys (`packages/cloudflare/src/Workers/Worker.ts`):
  - `name` (line 582, documented at 579) is optional. Without it, Alchemy derives "a deterministic physical name from the stack, stage, and logical ID". Today's names (`kumora-web`, `kumora-web-staging`) would have to be set explicitly or given up.
  - `compatibility: { date, flags }` (line 787). Defaults add `nodejs_compat` for dates before `2026-08-04`, and `new_module_registry` (lines 796–805).
  - `observability` (line 727).
  - `workersDev` (line 635) is `true` by default, which serves the stable `<worker>.<subdomain>.workers.dev` URL plus version previews (line 2203).
  - `env` (line 879) takes the bindings.
- **Two `env` channels.** Keys prefixed `VITE_` are inlined as `import.meta.env.*` at build time. Values that are `Output`s, such as `backend.url`, resolve before the build runs. `Cloudflare.Worker.URL` injects the site's own URL. All other keys become runtime bindings. `Config.Redacted(...)` values bind as `secret_text`. Sources: `cloudflare/frontend/vite.mdx` ("Environment") and `cloudflare/security/secrets-env.mdx:39-41`.
- **Reading bindings.** Server code reads bindings through `cloudflare:workers`, but behind a `Proxy`. A top-level `import { env } from "cloudflare:workers"` breaks under the TanStack Start dev server, because route modules are evaluated outside the request context. Sources: `tanstack-start.mdx` ("Read bindings in server code", line 126) and `examples/cloudflare-website-tanstack-start/src/env.ts`.
- **Rebuild skipping.** Files under `rootDir` that git does not ignore are content-hashed, together with the nearest lockfile. If nothing changed, both the build and the deploy are skipped. `memo.include` narrows which files are hashed. Source: `cloudflare/frontend/vite.mdx` ("Rebuilds and memo").
- **Prerendering.** "Prerendering through the preview server is matched" with `@cloudflare/vite-plugin`. Both apps use `tanstackStart({ prerender })` today. Source: `packages/cloudflare-runtime/src/vite/PARITY.md` ("Plugin identity and options"; the Preview table).

### 2. Does `wrangler.jsonc` / `wrangler types` survive?

Neither is used, and Alchemy does not generate them.

- **Config.** "Alchemy configures Workers in code, so `wrangler.json`, `.dev.vars`/`.env` loading, the Build Output Specification, deploy config redirects … have no counterpart." Source: `packages/cloudflare-runtime/src/vite/PARITY.md` (intro). Worker settings that would live in `wrangler.json` are "declared on the Website resource". Source: same file, "Plugin identity and options" table. The frontend overview says the same ("no `wrangler.json`, no adapter setup"): `cloudflare/frontend/frontends.mdx:11-15`.
- **Binding types.** `Cloudflare.InferEnv<typeof Website>` derives them from the declaration in TypeScript. No file is generated. Sources: `cloudflare/frontend/vite.mdx` ("Runtime bindings") and `cloudflare/security/secrets-env.mdx` ("Async Workers: the env prop").
- **Runtime API types.** The example takes `Request`, `ExecutionContext` and `cloudflare:workers` from the `@cloudflare/workers-types` package (`"types": ["bun", "vite/client", "@cloudflare/workers-types"]` in `examples/cloudflare-website-tanstack-start/tsconfig.json`). It does not use `wrangler types`. So `apps/*/wrangler.jsonc`, `apps/*/worker-configuration.d.ts`, the `cf-typegen` scripts and root `pnpm types:check` (`wrangler types --check`) all lose their purpose.
- **Login.** Authentication is not done through `wrangler login`. "No environment variables and no `wrangler login` required"; the profile is stored in `~/.alchemy/profiles.json`. Source: `cloudflare/setup.mdx:53-55`.

### 3. Local dev: what happens to `vite dev` with `@cloudflare/vite-plugin`

- **The official plugin must go.** "Alchemy appends its own Cloudflare Vite plugin (`@alchemy.run/cloudflare-runtime/vite`) and is **not compatible** with `@cloudflare/vite-plugin` in your `vite.config.ts`. Remove it." Sources: `cloudflare/frontend/vite.mdx` ("Remove `@cloudflare/vite-plugin`") and `tanstack-start.mdx:37`. The parity inventory adds that an official `cloudflare()` left in the config "is neutralized", so it does not crash. The docs still say to remove it. Source: `PARITY.md`, "Plugin identity and options".
- **Behaviour parity is tested.** Alchemy's plugin is checked for parity against `@cloudflare/vite-plugin` **1.65.0**, which is also the version range in `apps/*/package.json` here. Covered: the workerd module runner, HMR, `cloudflare:workers` `env`, `run_worker_first`, and the `ASSETS` binding through Vite's middlewares. Differential tests fail Alchemy's CI when the upstream plugin drifts. Source: `PARITY.md`, "How parity is enforced" and "Dev server".
- **`vite dev` is replaced by `alchemy dev`.** The Vite source (`packages/cloudflare/src/Workers/Sources/Vite.ts:131-138`) calls `vite.createServer({ root: rootDir, define, plugins: [cloudflare(pluginOptions)], server })` and then `listen()`. The app's `vite.config.ts` still loads, because `configFile` is not overridden; Alchemy only adds its plugin. Run plain `vite dev` with the official plugin removed and nothing provides workerd or `cloudflare:workers`. The docs never describe adding `@alchemy.run/cloudflare-runtime/vite` to `vite.config.ts` by hand (searched `website/src/content/docs` for `cloudflare-runtime/vite`: one hit, the caution above).
- **Port.** `dev.port` on the resource pins the port. The default is "an available port" according to `cloudflare/frontend/vite.mdx:245+`. `DEFAULT_DEV_PORT = 1337` is the fallback in `packages/cloudflare/src/Workers/ViteChild.shared.ts:18`, used at `LocalWorkerProvider.ts:468`. The apps' `--port 3000` and `inspectorPort: 0` would move onto the resource.
- **Process model.** `alchemy dev` re-runs the Stack under `bun --watch`, or `node --watch` with type stripping. It defaults to stage `dev_$USER`, while `deploy` defaults to `live_$USER`. `--config/-c` selects the Stack file. Source: `cli/dev.mdx:14` and its flags table.
- **The docs disagree on what bindings point at in dev.**
  - Real cloud resources: `tanstack-start.mdx` ("Deploy and dev"), `cloudflare/frontend/vite.mdx` ("Local dev") and `cli/dev.mdx` ("Resources are deployed to the cloud").
  - Local simulators by default, with `Alchemy.remote()` opting a resource into the real cloud: `cloudflare/local-development.mdx`, `environments/local-development.mdx`, and the changelog entry "Local emulation for alchemy dev" (`CHANGELOG.md:1349`). Local resource ids are prefixed `dev:`.

  The local-emulation pages look current and the other three look stale. This matters little for kumora now, because the apps bind only a secret, `DEPLOY_PROBE_SECRET`.

### 4. One Alchemy program for both apps in pnpm + Turborepo

- **Two documented layouts.** Option A is one Stack at the workspace root, "one plan, one state file". Option B is one Stack per package, linked by a typed `Alchemy.Stack<…>()("Name")` handle that reads persisted outputs. The docs advise: "Start with a Single Stack". Choose multiple Stacks for different deploy cadences, or when one app must be destroyed independently. Sources: `project-structure/monorepo.mdx` ("How to choose"), `monorepo-single-stack.mdx` and `monorepo-multi-stack.mdx`.
- **Anchor paths in a single Stack.** `alchemy` runs from the workspace root, so relative paths resolve from the root. Use `rootDir: path.resolve(import.meta.dirname, "apps/web")`. A custom entry is the exception: `vite.main` resolves from `rootDir`. Source: `monorepo-single-stack.mdx`, "Anchor every path" (lines 62–80). "The pattern scales by repetition": one `Website.Vite` per app, each yielded in the Stack.
- **No Turborepo coverage.** Alchemy has no Turborepo-specific docs, and does not care which package manager is used. `alchemy deploy` runs `vite build` itself, which overlaps with `turbo build` → `vite build` and with the content-hash skip. The spec must decide whether turbo still builds the apps for CI checks.

### 5. Is Bun required?

Bun is recommended, not required.

- **Prerequisites.** Getting started lists "Node.js 24.11.1+ or Bun" (`getting-started.mdx:22`).
- **CLI under Node.** The CLI bin `packages/alchemy/bin/cli.js` is a `#!/usr/bin/env node` script. It detects Bun and runs under it. Without Bun, it checks the Node version, installs an Oxc TypeScript loader and runs under Node. It rejects older Node with "Upgrade to node 22.22.3, 24.11.1 or newer" (line 114).
- **Engines.** The repo's `engines.node` is `>=22.18.0`, so Node 22.18 to 22.22.2 would be rejected if Node ran the tool. Choosing Bun, as the map settles, avoids that.
- **Install.** The install line pulls `effect`, `@effect/platform-bun` and `@effect/platform-node` (`getting-started.mdx:12`). `alchemy` declares peers `effect`, `vite` (`^7 || ^8`), `@effect/platform-bun`, `@effect/platform-node` and `ws` (`packages/alchemy/package.json`). Its catalog pins `effect: ^4.1.0`, so Alchemy v2 is on Effect 4.
- **Example scripts.** The TanStack example uses `bun test` and `"types": ["bun", …]`.

## Open questions for a grilling ticket

1. **Stack layout.** One root Stack for both apps (the doc default), or one Stack per app, so that web and dashboard deploy and destroy independently through Workers Builds?
2. **Worker names.** Pin the physical names (`kumora-web`, `kumora-web-staging`, …) with `name`, or let Alchemy derive them from stack, stage and id? This changes the `*.workers.dev` URLs.
3. **Local dev entry point.** Replace `vite dev` in the apps' `dev` scripts (and `turbo dev`, and e2e's dev server) with `alchemy dev`. Two things to settle: running one app alone (a Stack per app, or `--config`), and the `dev_$USER` stage, which may create real cloud resources for any resource with no local provider.
4. **Retiring wrangler.** Delete `wrangler.jsonc`, `worker-configuration.d.ts`, `cf-typegen` and `pnpm types:check`, and take runtime types from `@cloudflare/workers-types`. Is there any reason to keep `wrangler` (for example `wrangler tail`, given that Alchemy has `alchemy logs`)?
5. **Build ownership.** `alchemy deploy` runs `vite build` itself. Does `turbo build` stay as a CI check only, and does e2e run against a `vite preview` built by Alchemy's plugin?
6. **The `env` proxy.** Adopt the documented `Proxy` wrapper over `cloudflare:workers`, or read bindings through Effect (`Config`) in the server code, given that Effect owns server code?
7. **Compatibility date.** Set `compatibility.date` explicitly. Alchemy bundles its own workerd, so the comment in today's `wrangler.jsonc` about the binary's date limit needs re-checking against Alchemy's workerd.
