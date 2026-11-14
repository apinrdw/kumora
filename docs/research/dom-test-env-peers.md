# DOM test environment without splitting alchemy

Research for [#106](https://github.com/apinrdw/kumora/issues/106), child of the map [#98](https://github.com/apinrdw/kumora/issues/98). Found by the prototype [#102](https://github.com/apinrdw/kumora/issues/102). Measured on 2026-11-07 against `main` at `bb07ca4d8a`, with pnpm 11.25.0 (`packageManager` in `package.json`).

## Answer

- **happy-dom does not fork alchemy.** Adding it changes the peer suffix of `vitest` and `@effect/vitest` everywhere, but each still has one variant. alchemy's peer chain has no `vitest`. A full `pnpm install` with happy-dom typechecks clean: 0 errors in every package.
- **The 133 errors come from a partial install.** `pnpm --filter dashboard add …` in a worktree with no `node_modules` links only `apps/dashboard` and the root. The dashboard typechecks `packages/ui` and `packages/deploy` from source, and those packages have no `node_modules`. 132 errors are unresolved imports there. The one `alchemy.run.ts` error (two `SecretsLayer` types) comes from `packages/deploy/src/stack.ts` resolving `@alchemy.run/infisical` up to the root's copy, which is bound to a different alchemy variant. Adding `scheduler` the same way gives the same 133 errors, with no happy-dom.
- **`main` already has two alchemy variants.** The fork is `ws`: the root declares `ws ^8.22.0`, locked at 8.22.0, and `@effect/platform-node-shared` pulls `ws@8.22.1`. alchemy has `ws` as an optional peer, so the root's alchemy (through `@alchemy.run/infisical`) and the apps' alchemy differ. It is harmless while every package is linked, but any partial link or `dedupePeers` turns it into the `SecretsLayer` error.
- **Fix:** run a full `pnpm install` after any filtered `pnpm add` (or install with `--filter 'dashboard...'`), and run `pnpm dedupe` in the PR that adds the DOM package. `pnpm dedupe` moves the root's `ws` to 8.22.1, which leaves one alchemy copy. Declare `happy-dom` as a devDependency of each package whose tests use it (`apps/dashboard`, `packages/ui`). Measured result: dashboard `tsc` 0 errors, 1 `alchemy@` dir, `pnpm check` passes.
- **Don't use `dedupePeers: true`.** It keeps the `ws` fork and collapses `@alchemy.run/infisical` onto one snapshot, so `apps/dashboard` and `apps/web` fail with the `SecretsLayer` error even after a full install.

## 1. What the lockfile says

| Fact | Source |
| --- | --- |
| alchemy's peers: `@alchemy.run/frontend-frameworks`, `@effect/platform-bun`, `@effect/platform-node`, `effect`, `vite`, `ws`. All except `effect` are optional. There is no `vitest` or `@effect/vitest`. | `pnpm-lock.yaml` on `main`, `packages:` entry `alchemy@2.0.0-beta.85` |
| `main` has two alchemy snapshots. They differ only in the last suffix: `(ws@8.22.0)` and `(ws@8.22.1)`. | `pnpm-lock.yaml` on `main`, `snapshots:` lines 6173 and 6195 |
| The root importer has `ws: specifier ^8.22.0, version 8.22.0`, and its `@alchemy.run/infisical` is bound to the `ws@8.22.0` alchemy. `apps/dashboard`, `apps/web` and `packages/deploy` all resolve the `ws@8.22.1` alchemy, and `packages/deploy` has its own `@alchemy.run/infisical` snapshot bound to it. | `pnpm-lock.yaml` `importers:` |
| `@effect/platform-node-shared@4.1.2` depends on `ws: 8.22.1`. That is where the apps' `ws@8.22.1` comes from. | `pnpm-lock.yaml` `snapshots:` |
| happy-dom's diff to the lockfile: `vitest@5.0.5(…)` becomes `vitest@5.0.5(…)(happy-dom@21.0.4)(…)` in every importer, and `@effect/vitest` follows. There is still one `vitest` snapshot, one `@effect/vitest` snapshot and the same two alchemy snapshots. | `git diff pnpm-lock.yaml` after `pnpm --filter dashboard add -D happy-dom@21.0.4` |
| The prototype branch's lockfile has the same shape: every importer resolves the same alchemy variant. A fresh `pnpm install --frozen-lockfile` of `origin/prototype/atom-seam-data-table` gives one dashboard `tsc` error, in `bench.test.tsx` (see section 4), and none in `alchemy.run.ts`. | `git checkout origin/prototype/atom-seam-data-table -- .`, then install and `tsc` |

`@effect/vitest` gets a renamed peer variant, not a second one. pnpm's `dedupePeerDependents` (default `true`) moves every `vitest` consumer onto the happy-dom variant.

## 2. Reproducing the 133 errors

The failing state needs a worktree with no `node_modules` and a filtered add:

```sh
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm --filter dashboard add -D happy-dom@21.0.4
cd apps/dashboard && pnpm exec tsc --noEmit   # 133 errors
```

After the add, only the root and `apps/dashboard` have `node_modules`. `packages/deploy`, `packages/ui` and `apps/web` have none. `tsc --traceResolution` shows:

- From `packages/deploy/src/stack.ts`, `alchemy` is "not resolved", so its types become `any` (`providers: any; state: any` in the first error).
- From the same file, `@alchemy.run/infisical` resolves through the root's `node_modules` to snapshot `…16cda54a…`, which links the `ws@8.22.0` alchemy (`…8cf9a3b1…`). The dashboard's own `alchemy` is `…17ce30b0…`. Two alchemy copies give two `SecretsLayer` types, which is the first error the prototype reported.
- The other 132 errors are in `packages/ui/src/components/*` (for example 39 in `chart.tsx`) and `packages/deploy/src/stack.ts`, from imports that do not resolve.

A plain `pnpm install` afterwards links every package and the count drops to 0. The prototype ticket reported that `@effect/atom-react` and `scheduler` alone typecheck clean. That run was most likely after a full install: the same filtered add of `scheduler@0.28.0` in a fresh worktree gives 133.

## 3. Candidate fixes

Each candidate starts from `main` with the config change applied. **F** is the failing scenario: delete every `node_modules`, run the filtered add, run dashboard `tsc`. **I** follows F with a full `pnpm install` and runs `tsc` in each package. "Dirs" counts `alchemy@*` under `node_modules/.pnpm`, and "keys" counts alchemy snapshots in `pnpm-lock.yaml`.

| Candidate | F: dashboard tsc | F: dirs | I: tsc dashboard / web / deploy / ui | I: dirs | Lock keys |
| --- | --- | --- | --- | --- | --- |
| `main`, no change | n/a | n/a | 0 / 0 / 0 / 0 | 2 | 2 |
| Control: `scheduler@0.28.0`, no DOM package | 133 | 2 | 0 / 0 / 0 / 0 | 2 | 2 |
| `happy-dom@21.0.4` in `apps/dashboard` | 133 | 2 | 0 / 0 / 0 / 0 | 2 | 2 |
| `jsdom` in `apps/dashboard` | 133 | 2 | 0 / 0 / 0 / 0 | 2 | 2 |
| `overrides: { ws: 8.22.1 }` + happy-dom | 132 | 1 | 0 / 0 / 0 / 0 | 1 | 1 |
| `pnpm dedupe` + happy-dom | 132 | 1 | 0 / 0 / 0 / 0 | 1 | 1 |
| `dedupePeers: true` + happy-dom | 133 | 2 | **1 / 1** / 0 / 0 | 2 | 2 |
| `peerDependencyRules` (`allowedVersions` and `allowAny` for `ws`) + happy-dom | 133 | 2 | 0 / 0 / 0 / 0 | 2 | 2 |
| happy-dom at the root (`pnpm add -w -D`) | 2¹ | 1 | 0 / 0 / 0 / 0 | 2 | 2 |
| **Winner:** happy-dom in `apps/dashboard` and `packages/ui`, `pnpm install`, `pnpm dedupe` | 0² | 1 | 0 / 0 / 0 / 0 | 1 | 1 |

¹ `pnpm add -w` in a fresh worktree links only the root, so dashboard `tsc` stops at `Cannot find type definition file for '@cloudflare/workers-types'` and `'vite/client'`.
² Measured after `pnpm install --frozen-lockfile` from no `node_modules`, and again with `pnpm --filter 'dashboard...' install --frozen-lockfile`, which links `apps/dashboard`, `packages/deploy` and `packages/ui`.

What the rows show:

- **No lockfile or config change fixes scenario F.** Even with one alchemy copy (`overrides`, `dedupe`), the unlinked workspace packages still give 132 errors. The fix for F is to install the whole workspace, or the app and its dependencies (`--filter 'dashboard...'`).
- **jsdom and happy-dom behave the same.** Both are optional peers of vitest, so either one only renames the vitest peer suffix. Choose between them on other grounds; the prototype bench already uses happy-dom.
- **`pnpm dedupe` and `overrides` both remove the latent `ws` fork.** `dedupe` changes only the lockfile: the root's `ws` moves from 8.22.0 to 8.22.1 inside its existing `^8.22.0` range. In this run it also removed some unused snapshots (`browserslist`, `caniuse-lite`, `srvx` and others), and `pnpm check` still passed. An `overrides` entry pins `ws` permanently, and someone has to bump it by hand. Prefer `dedupe`.
- **`dedupePeers: true` makes it worse.** Snapshot suffixes become `name@version`, so `@alchemy.run/infisical@2.0.0-beta.85(alchemy@2.0.0-beta.85)(effect@4.1.2)` is one snapshot for both alchemy variants. That snapshot links the `ws@8.22.0` alchemy, while `apps/dashboard` and `apps/web` import the `ws@8.22.1` one. The result is the `SecretsLayer` error in `alchemy.run.ts` after a full install.
- **`peerDependencyRules` changes nothing.** Its options only silence peer warnings, and the current docs mark it deprecated.
- **Root placement works at runtime but hides the dependency.** vitest loads `happy-dom` as its own peer, so the package works from any vitest snapshot that has it. Declaring it per package keeps each package's test needs in its own `package.json`, and the lockfile still has one vitest snapshot.

## 4. Checking the winner

- happy-dom 21.0.4 was added to `apps/dashboard` and `packages/ui` with `pnpm --filter dashboard --filter @workspace/ui add -D happy-dom@21.0.4`, then `pnpm install`, then `pnpm dedupe`.
- A throwaway test with `// @vitest-environment happy-dom` that mounts a React root with `createRoot` passed in both `packages/ui/tests` and `apps/dashboard/tests`. The existing `packages/ui/tests/components/chart.test.tsx` (25 tests, `renderToStaticMarkup`) still passed.
- `pnpm check` exited 0: typecheck, lint, format, tests in every package, and the root scripts.
- **Side finding:** `document.body.append(el)` does not typecheck in `apps/dashboard`: `Argument of type 'HTMLDivElement' is not assignable to parameter of type 'string | ReadableStream<any> | Response'`. The dashboard `tsconfig.json` has `"types": ["vite/client", "@cloudflare/workers-types"]`, and the error's parameter type matches the HTMLRewriter `Element.append` from Workers types, which most likely shadows the DOM signature. `appendChild` typechecks. This is the one error left on the prototype branch. `packages/ui` does not load Workers types and accepts `append`. A tests-only tsconfig for the dashboard would also avoid the clash.

## 5. pnpm settings used

The pnpm.io pages now document pnpm 12 (they cite v12.7.0 behavior). The defaults below were checked in the installed pnpm 11.25.0 bundle, `node_modules/pnpm/dist/pnpm.mjs`, which defines `"auto-install-peers": true`, `"dedupe-peer-dependents": true`, `"dedupe-peers": false`, `"dedupe-direct-deps": false`, `"recursive-install": true` and `"resolve-peers-from-workspace-root": true`.

| Setting | Documented behavior | Source |
| --- | --- | --- |
| `dedupePeerDependents` (default `true`) | "packages with peer dependencies will be deduplicated after peers resolution." This is why happy-dom moves every importer onto one vitest snapshot. | [pnpm.io/settings/peer-dependencies](https://pnpm.io/settings/peer-dependencies) |
| `dedupePeers` (default `false`) | "peer dependency suffixes use version-only identifiers (`name@version`) instead of full dep paths." | same page |
| `resolvePeersFromWorkspaceRoot` (default `true`) | Root dependencies are used to resolve peers of workspace projects. Even so, the apps' alchemy resolved its optional `ws` peer to 8.22.1, the version `@effect/platform-node-shared` already brings into their tree, and not to the root's 8.22.0. That is measured; why the root's version loses is inferred and not traced in pnpm source. | same page |
| `peerDependencyRules` (`ignoreMissing`, `allowedVersions`, `allowAny`) | Deprecated. Each option only suppresses peer warnings. | same page |
| `--filter` | "restrict commands to specific subsets of packages". `<pkg>...` selects the package and its dependencies. | [pnpm.io/filtering](https://pnpm.io/filtering) |
| `overrides` | Lives in `pnpm-workspace.yaml` and applies to the whole shared lockfile. | [pnpm.io/settings](https://pnpm.io/settings), "Dependency resolution" |

The docs don't say whether a filtered `pnpm add` links only the selected projects. Section 2 shows that it does.
