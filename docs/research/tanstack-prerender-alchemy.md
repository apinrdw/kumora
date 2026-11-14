# TanStack Start prerendering under Alchemy's Vite build

Research for [#23](https://github.com/apinrdw/kumora/issues/23) (map [#10](https://github.com/apinrdw/kumora/issues/10), blocks [#22](https://github.com/apinrdw/kumora/issues/22)). Researched 2026-11-05.

Sources:

- Alchemy `2.0.0-beta.85` as installed from npm on [`scratch/alchemy-throwaway-deploy`](https://github.com/apinrdw/kumora/tree/scratch/alchemy-throwaway-deploy), and the Alchemy repo [`alchemy-run/alchemy`](https://github.com/alchemy-run/alchemy) at `main` commit `5bbe9aa4` (2026-11-04). The files cited below are the same in both, apart from two added lint comments that shift `Workers/Sources/Vite.ts` by two lines on `main`. Line numbers are for `main`.
- `@tanstack/start-plugin-core` 1.171.55, `vite` 8.3.4 and `@cloudflare/vite-plugin` 1.65.0, as installed in this repo. TanStack paths are relative to `node_modules/@tanstack/start-plugin-core/dist/esm/`.
- Local runs on this machine with Bun 1.4.4, no cloud credentials. Nothing was deployed.

## Answer

- **Cause.** TanStack's prerender step doesn't pick a runtime. It always calls `vite.preview({ configFile })`, which resolves `vite.config.ts` again **from the file**. Alchemy adds its Cloudflare plugin only to the **inline** config of its own `createBuilder` call. So the preview server that TanStack starts never has Alchemy's plugin. TanStack's fallback preview middleware then `import()`s `dist/server/server.js` into the build process, which is Bun, and Bun can't resolve `cloudflare:workers`. With `@cloudflare/vite-plugin`, the plugin is in the file itself, so the preview server starts Miniflare and every request renders in workerd.
- **Alchemy support.** None for TanStack. No issue or PR covers it. The "prerendering through the preview server is matched" row in `PARITY.md` is backed by a fixture that has the same gap: reproduced offline, its preview answered `404` and it wrote an empty `prerendered.html`. Alchemy's own Waku docs already say that SSG renders in Node and tell users to import `cloudflare:workers` dynamically.
- **Workarounds tested.** A lazy `cloudflare:workers` import works. So does adding Alchemy's plugin to `vite.config.ts` for `isPreview` only, which prerenders in workerd. Prerender off works too, but gives up the static page. Running `vite preview` after the build doesn't help: Alchemy has no hook between its build and its asset upload, and on its own `vite preview` hits the same Bun failure.
- **Recommendation.** Keep prerendering in `apps/web` and move the probe's `cloudflare:workers` import inside its handler. If a module that must import `cloudflare:workers` at the top level ever reaches the server bundle, switch to the `isPreview` plugin. Details are under [Recommendation](#recommendation).

## Findings

### 1. How TanStack Start prerenders

- **Hook.** `tanstack-start-core:post-build` is a `buildApp` hook with `enforce: "post"` and `order: "post"`. It runs after both environments are built (`vite/plugins.js:38-52`), inside the same `builder.buildApp()` call, and calls `postServerBuild` → `prerenderWithVite` (`vite/post-server-build.js:5-19`).
- **Preview server.** `prerenderWithVite` starts a preview server with `vite.preview({ configFile: viteConfig.configFile, preview: { port: 0, open: false } })` (`vite/prerender.js:12`, `34-47`). It then crawls by `fetch`ing that server (`prerender.js:128-143`). The only thing it passes on from the running build is `configFile`, not the resolved plugins.
- **Vite re-resolves the config.** `preview(inlineConfig)` calls `resolveConfig(inlineConfig, "serve", "production", "production", true)` (`vite/dist/node/chunks/node.js:35640-35642`). That loads `vite.config.ts` from scratch with `isPreview: true`. Plugins that a caller passed inline to an earlier `createBuilder` are not part of it.
- **TanStack's fallback server.** TanStack always registers `tanstack-start-core:preview-server` (`vite/plugin.js:158`). Its `configurePreviewServer` returns a function, so Vite installs the middleware **after** its own. The middleware `import()`s the built server entry into the current process and calls `serverBuild.fetch` (`vite/preview-server-plugin/plugin.js:12-37`). This only runs when no earlier middleware has answered the request.
- **Why `@cloudflare/vite-plugin` gets workerd.** Its `previewPlugin.configurePreviewServer` starts Miniflare over the build output and calls `middlewares.use(...)` directly, which puts it ahead of TanStack's middleware (`@cloudflare/vite-plugin/dist/index.mjs:93901-93940`). On `main`, `cloudflare()` is in `apps/web/vite.config.ts`, so the re-resolved preview config contains it. **Tested:** `vite build` in `apps/web` on `main` logs `GET / 200 OK` from Miniflare and writes `dist/client/index.html`.
- **Filtering doesn't stop the import.** The `filter` that excludes `/probe` only skips crawling that path. The probe route's top-level `import { env } from "cloudflare:workers"` sits in the `router-*.js` chunk, which the server entry loads for **every** request. So the very first request (`/`) fails, as the deploy log showed.

### 2. What Alchemy does

- **The plugin is added inline.** `viteBuildInProcess` calls `vite.createBuilder({ root, define, plugins: [cloudflare(pluginOptions), outputPlugin.plugin], … }, null)` and then `builder.buildApp()` (`packages/cloudflare/src/Workers/Sources/Vite.ts:203-246`, with the plugins on line 223). The user's `vite.config.ts` is still loaded, but Alchemy's plugin exists only in this inline config. `alchemy dev` adds it the same way (`Vite.ts:134`).
- **The build runs on the engine's runtime.** `runViteBuildChild` spawns `process.execPath` (`packages/cloudflare/src/Workers/ViteChild.ts:230`). Under `bun alchemy deploy` that is Bun, so TanStack's fallback middleware imports the server bundle in Bun. Under Node it would fail the same way, because Node can't resolve `cloudflare:workers` either.
- **Alchemy's preview plugin would handle it.** `distilled-cloudflare:preview` starts workerd over the entry environment's `build.outDir` and serves the client assets (`packages/cloudflare-runtime/src/vite/preview-plugin.ts:9-28`, wired in at `plugin.ts:253`). Its JSDoc says this "makes SSG-in-workerd work". But it only runs when Alchemy's plugin is in the **preview** config, and a framework that calls `vite.preview({ configFile })` drops it.
- **`PARITY.md` overstates support.** The `experimental.prerenderWorker` row reads "Out of scope (experimental); prerendering through the preview server is matched", citing `ViteBuild.test.ts` (`packages/cloudflare-runtime/src/vite/PARITY.md:43`, also `:103`). The fixture behind that test (`packages/integration-tests/test/Cloudflare/Website/vite-prerendering-fixture/vite.config.ts`) also calls `preview({ root })` from a config file that has no Cloudflare plugin. **Tested offline** with Alchemy's plugin passed inline, as Alchemy passes it: the preview answered `404` with an empty body, and the fixture wrote a 0-byte `dist/client/prerendered.html`. The live test checks only the deployed URL, where the Worker renders `/prerendered` on request (`fixture/src/index.ts`). I didn't run it, because it needs credentials, so I can't say how it passes in CI. Either way, it doesn't show that a page was rendered in workerd at build time.
- **Alchemy's Waku docs admit the gap.** "Prefer a guarded dynamic import in page modules — Waku's SSG step renders static pages in Node, where a top-level `import { env } from "cloudflare:workers"` cannot resolve" (`packages/cloudflare/src/Website/Waku.ts:161-166`). That contradicts the `preview-plugin.ts` JSDoc, which names Waku as the case that works.
- **No hook for a later step.** `Website.Vite` props are `WorkerProps` plus `rootDir`, `memo`, `viteEnvironments`, `assets` and `dev`, and there is no build command (`packages/cloudflare/src/Website/Vite.ts:15-22`, `176-186`). Alchemy reads the assets from `clientDirectory` straight after the build child exits (`Workers/Sources/Vite.ts:417-440`). So files written inside `buildApp` are uploaded, and nothing written after the build is.
- **Issues and PRs.** `gh search issues` and `gh search prs` on `alchemy-run/alchemy` for `prerender`, `tanstack prerender`, `cloudflare:workers prerender`, `vite preview`, `prerenderWorker`, `SSG workerd` and `TanStack Start` found nothing on TanStack prerendering or preview-server plugin loss. Related but not about this:
  - [#1432](https://github.com/alchemy-run/alchemy/issues/1432), open: a proposed `vite-plugin-alchemy` for `vite.config.ts`. The maintainer replied "Alchemy wraps Vite. Vite should not wrap Alchemy."
  - [#1313](https://github.com/alchemy-run/alchemy/pull/1313), merged: Foldkit SSG, which Alchemy supports through its own `framework: "foldkit"` path.
  - [#1242](https://github.com/alchemy-run/alchemy/pull/1242), merged: forwarding Astro's prerender environment.
- **Examples.** None of Alchemy's TanStack examples turn prerendering on (known from the brief, not re-checked).

### 3. Workarounds

Each was run with Alchemy's real build child, `ViteBuildChildRunner.ts` from beta.85, fed a V8-serialized config on stdin and spawned with `bun run` as `ViteChild.ts:215-240` does. The app was `apps/web` from the scratch branch with prerender turned back on. The original config reproduces the deploy failure offline: `Cannot find package 'cloudflare:workers' from 'dist/server/assets/router-*.js'`, exit 1.

| Workaround | Result | Tested |
|---|---|---|
| (a) Prerender off | Builds. Every page, `/` included, is rendered by the Worker on each request. | Yes (the scratch deploy, `ed289120-…`) |
| (b) Lazy `cloudflare:workers` import | Builds and prerenders `/` in Bun. `/probe` keeps working at runtime. | Yes |
| (c) `vite preview` after the build | Doesn't fit Alchemy. With the shipped config it fails the same way. | Partly |
| (d) Alchemy's plugin in `vite.config.ts` for `isPreview` | Builds and prerenders `/` in workerd. | Yes |
| (e) Static assets step | Not applicable. | Source only |

**(a) Prerender off.** This is what the scratch deploy used. The cost is that `/`, the only static page in `apps/web` today, costs a Worker invocation and an SSR render on every request, instead of being served free from static assets. `apps/dashboard` on `main` doesn't prerender at all (plain `tanstackStart()`), so it isn't affected.

**(b) Lazy import.** In `src/routes/probe.ts`, drop the top-level import and write `const { env } = await import("cloudflare:workers")` inside the `GET` handler. The build child then prerendered `/` and exited 0. Rolldown kept the import dynamic in the `router-*.js` chunk. Bun never resolves `cloudflare:workers`, whether it appears statically or dynamically, so this works only because the dynamic import never runs during prerender. Costs:
- Every `cloudflare:workers` import anywhere in the server graph must be dynamic, and that includes dependencies. A single static import fails the whole build, though it fails loudly (`failOnError` defaults to `true`, `prerender.js:118`), so it can't ship a broken page.
- Prerendered pages render in Bun, not workerd, so runtime parity isn't guaranteed for those pages. Today that is only `/`.
- A prerendered page can't read bindings. Only `/probe` reads one, and the filter already excludes it.

**(c) `vite preview` after the build.** Alchemy builds and uploads in one resource step. It offers no build command and no hook between the two (see section 2), so a separate prerender pass would have to write into `dist/client` before Alchemy reads it, which nothing allows. I also ran `vite preview` from the CLI on a prerender-off build with the shipped config. It answered `500`, with `Cannot find package 'cloudflare:workers'` in Bun, the same failure as before. It works only together with (d), which already fixes the in-build prerender.

**(d) Alchemy's plugin for `isPreview`.** TanStack's preview loads the config file with `isPreview: true`, but Alchemy's build loads it with `false`. So adding the plugin to the file only for preview doesn't run it twice during the build:

```ts
import alchemyCloudflare from "@alchemy.run/cloudflare-runtime/vite"

export default defineConfig(({ isPreview }) => ({
  plugins: [
    isPreview
      ? alchemyCloudflare({ compatibilityDate: "2026-10-26", compatibilityFlags: ["nodejs_compat"] })
      : null,
    // devtools(), tailwindcss(), tanstackStart({ prerender: … }), viteReact()
  ],
}))
```

The build child logged workerd's startup lines (`service user-worker: …`), prerendered `/` and exited 0, all with the probe's top-level static import left in place. With prerender off, `vite preview` on the same config answered `/` with `200`, and `/probe` with `{"secretPresent":false}`. The page ran in workerd with no bindings, because Alchemy passes only compatibility options to the build plugin. Costs:
- `apps/web` needs a direct dependency on `@alchemy.run/cloudflare-runtime`, which pnpm requires. I tested with a symlink.
- The compatibility date and flags are written twice, in `alchemy.run.ts` and in `vite.config.ts`, and can drift apart.
- It depends on two things neither project documents: that TanStack prerenders through `vite.preview({ configFile })`, and that Alchemy's plugin works when loaded from a user config. Alchemy's docs say only to remove `@cloudflare/vite-plugin` (`website/src/content/docs/cloudflare/frontend/vite.mdx:60-76`). The maintainer's reply on #1432 suggests they don't want the plugin to live in `vite.config.ts`.
- Bindings are still missing during prerender, as in (b).

**(e) Static assets step.** `Cloudflare.Website.StaticSite` covers a build command that outputs only files. It doesn't fit an SSR app, and `Website.Vite` has no extra-assets input. Not tried.

**Deployed serving (source only).** Alchemy uploads whatever the build left in `clientDirectory` (`Workers/Sources/Vite.ts:417-440`). Without `runWorkerFirst`, Cloudflare serves a matching asset such as `index.html` before it calls the Worker. I didn't deploy a prerendered build to confirm this.

## Recommendation

- **Keep prerendering in `apps/web` with (b).** Move the probe's `cloudflare:workers` import inside its `GET` handler. It's a one-line change, it matches Alchemy's own guidance for Waku, and it needs no new dependency. A future static import fails the build rather than the site. The only loss compared with `main` today is that `/` is prerendered in Bun instead of workerd. Keep the `/probe` filter, because that route reads a binding.
- **Fall back to (d)** if the spec brings in a module that must import `cloudflare:workers` at the top level and ends up in the server bundle, such as an Effect layer built from `env`. Record it as a `Decision:` comment in `vite.config.ts` and pin it to the beta.
- **Don't use (a) or (c).** (a) gives up static serving of `/` for nothing, and (c) doesn't fit Alchemy's single build-and-upload step.
- **Dashboard.** It doesn't prerender today, so nothing changes. If it ever prerenders, the same rule applies.
- **Upstream (optional).** File an Alchemy issue: Alchemy's plugin doesn't reach a `vite.preview({ configFile })` started from inside `buildApp`, and the `PARITY.md` prerender row and its fixture don't exercise that case. Whether to file it is your call.
