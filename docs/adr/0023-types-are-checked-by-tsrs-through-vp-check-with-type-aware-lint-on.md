# Types are checked by tsrs through vp check, with type-aware lint on

`vp check` lints, formats and type-checks the whole repo in about 1.5 s, against about 7 s for a turbo `tsc --noEmit` task per package. The root `vite.config.ts` turns on `lint.options.typeAware` and `typeCheck` (tsrs refuses to type-check without type-aware linting), so `vp check` reports TypeScript's diagnostics and the correctness category's type-aware rules (await-thenable, no-base-to-string and the rest). tsrs follows each file's nearest `tsconfig.json`, so per-package options such as `noUncheckedIndexedAccess`, the ES2022-only lib and the dashboard tests' own tsconfig still apply. One cached root turbo task, `//#vp-check`, runs `vp check --deny-warnings` over every file in the repo and replaces the per-package `typecheck`, `lint` and `format:check` tasks and their root counterparts; no package has those scripts any more. `typescript` stays a devDependency for editors and type imports, and no check runs `tsc` beside tsrs.

The risk is that tsrs is a beta: vite-plus 1.8.0 pins `tsrs` 7.1.0-beta.tsrs4, a Rust port of TypeScript 7.1.0-beta. It reports a false TS5115 at `packages/server/src/bridge.ts`'s `import("cloudflare:workers")`, a TypeScript 7.1 regression fixed upstream (microsoft/TypeScript#65481) but not in this tsrs (oxc-project/tsrs#1113); an explicit return type on that import works around it, and comes out once vite-plus ships a fixed tsrs. Going back to tsc means a `typecheck` task per package again and turning `typeCheck` off. This reverses ADR-0011, which left type-aware rules off and kept `tsc --noEmit` as the type gate; ADR-0011 is marked superseded by ADR-0022, which carries its Oxlint and Oxfmt choice forward.

Sites:

- `turbo.json`
- `vite.config.ts`

Source: apinrdw/kumora#729
