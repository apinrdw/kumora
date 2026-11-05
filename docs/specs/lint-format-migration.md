# Spec: migrate lint and format to Oxlint and Oxfmt

Executable handoff for [ADR-0001](../adr/0001-oxlint-and-oxfmt-replace-eslint-and-prettier.md). Decisions and their evidence live on the wayfinder map [#3](https://github.com/apinrdw/kumora-monorepo/issues/3); the tickets linked below hold the detail. Everything here was verified against `main` at `a1e51f3` on 2026-10-27 with Oxlint 1.90.0 and Oxfmt 0.75.0.

## Outcome

- ESLint, Prettier, and their configs are gone from every workspace.
- One `.oxlintrc.json` and one `.oxfmtrc.json` at the root; workspaces keep thin scripts so Turbo tasks and caching stay as they are.
- CI runs lint and a new format check after install; both are green on `main`.
- Editors pick up both tools through one extension.

## Execution order

Each step leaves the repo in a working state. Do them in one branch, squash or keep as you like, but step 7's commit must be its own commit so its SHA can go in `.git-blame-ignore-revs`.

1. **Install.** At the root: `pnpm add -D -w oxlint@1.90.0 oxfmt@0.75.0` (exact pins, no caret). Remove `prettier` and `prettier-plugin-tailwindcss` from root devDependencies. In each of `apps/web`, `apps/dashboard`, `packages/ui`, remove `eslint` and `@tanstack/eslint-config` from devDependencies. Check whether `.npmrc` `legacy-peer-deps=true` existed only for the ESLint tree; drop it if `pnpm install` is clean without it.
2. **Root configs.** Write the two files in [Configs](#configs) verbatim.
3. **Delete.** `apps/web/eslint.config.js`, `apps/dashboard/eslint.config.js`, `packages/ui/eslint.config.js`, `.prettierrc`, `.prettierignore`.
4. **Scripts.** In each workspace `package.json`:
   - `"lint": "oxlint"`
   - `"format": "oxfmt --write \"**/*.{ts,tsx}\""`
   - `"format:check": "oxfmt --check \"**/*.{ts,tsx}\""`
   Root `package.json` gains `"format:check": "turbo format:check"`.
5. **Turbo.** In `turbo.json` add a `format:check` task with no `dependsOn`, and add `"globalDependencies": [".oxlintrc.json", ".oxfmtrc.json"]` so rule changes invalidate cached `lint`, `format`, and `format:check` results. Read the installed Turbo docs first, per `AGENTS.md`.
6. **CI.** In `.github/workflows/ci.yml` add `- run: pnpm format:check` after `pnpm lint`. Keep it after `pnpm install`. Oxlint switches to GitHub annotations automatically on Actions; no flag needed.
7. **Fix, then reformat, two commits.** Run `pnpm exec oxlint`, fix the 7 findings in [Known findings](#known-findings), and commit. Run `pnpm format` (11 files change, listed below) and commit that alone, then add the reformat commit's SHA to a new `.git-blame-ignore-revs` and run `git config blame.ignoreRevsFile .git-blame-ignore-revs` locally.
8. **Editors.** Add the two files in [Editor](#editor).
9. **Docs.** `AGENTS.md` already has the Oxlint and Oxfmt section. Grep README and `docs/` for ESLint and Prettier mentions (none existed on 2026-10-27) and update any that appear.
10. **Verify.** From the root: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` all exit 0. `pnpm exec oxlint --deny-warnings` exits 0. `cd apps/dashboard && pnpm lint` finds the root config through nested lookup (verified) and reports nothing.

## Configs

### `.oxlintrc.json`

Verified in [Decide: disposition of every TanStack preset rule](https://github.com/apinrdw/kumora-monorepo/issues/7). Runs over all three workspaces in 1.4s.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "react", "jsx-a11y", "vitest"],
  "categories": { "correctness": "error" },
  "rules": {
    "no-unused-vars": ["error", { "varsIgnorePattern": "^_", "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
    "no-case-declarations": "error",
    "no-fallthrough": "error",
    "no-regex-spaces": "error",
    "no-shadow": "warn",
    "no-var": "error",
    "prefer-const": "error",
    "typescript/ban-ts-comment": ["error", { "ts-expect-error": false, "ts-ignore": "allow-with-description" }],
    "typescript/consistent-type-imports": ["error", { "prefer": "type-imports" }],
    "typescript/method-signature-style": ["error", "property"],
    "typescript/no-inferrable-types": ["error", { "ignoreParameters": true }],
    "typescript/no-namespace": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/prefer-for-of": "warn",
    "unicorn/prefer-node-protocol": "error",
    "import/first": "error",
    "import/newline-after-import": "error",
    "import/no-commonjs": "error",
    "import/no-duplicates": "error",
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "warn",
    "react/set-state-in-effect": "warn",
    "react/set-state-in-render": "warn",
    "react/purity": "warn",
    "react/immutability": "warn",
    "react/refs": "warn",
    "react/use-memo": "warn",
    "react/void-use-memo": "warn",
    "react/static-components": "warn",
    "react/globals": "warn",
    "react/error-boundaries": "warn",
    "react/preserve-manual-memoization": "warn",
    "react/incompatible-library": "warn",
    "react/hooks": "warn",
    "react/memo-dependencies": "warn",
    "react/exhaustive-effect-dependencies": "warn",
    "react/capitalized-calls": "warn",
    "react/invariant": "warn",
    "react/rule-suppression": "warn",
    "react/syntax": "warn",
    "react/unsupported-syntax": "warn",
    "react/todo": "warn",
    "jsx-a11y/prefer-tag-over-role": "off",
    "vitest/no-focused-tests": "error",
    "vitest/no-disabled-tests": "warn",
    "vitest/no-identical-title": "error",
    "vitest/valid-expect": "error",
    "vitest/valid-title": "error"
  },
  "ignorePatterns": ["**/routeTree.gen.ts", "**/dist/**", "**/.output/**", "**/.nitro/**", "**/.tanstack/**", "**/coverage/**"]
}
```

### `.oxfmtrc.json`

Verified in [Decide: oxfmt config and the Tailwind sorting fallback](https://github.com/apinrdw/kumora-monorepo/issues/8). Equivalent to `oxfmt --migrate=prettier` output plus the generated-file ignore. Class order is byte-identical to `prettier-plugin-tailwindcss` 0.8.1 on this repo, from the root or from a workspace directory.

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "endOfLine": "lf",
  "semi": false,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 80,
  "sortPackageJson": false,
  "sortTailwindcss": {
    "stylesheet": "packages/ui/src/styles/globals.css",
    "functions": ["cn", "cva"]
  },
  "ignorePatterns": [
    "**/routeTree.gen.ts",
    "dist/",
    ".turbo/",
    ".output/",
    ".nitro/",
    ".tanstack/",
    "coverage/"
  ]
}
```

## Rule dispositions

Source: [Research: oxlint rule mapping for the TanStack ESLint preset](https://github.com/apinrdw/kumora-monorepo/issues/4), cross-checked with `npx @oxlint/migrate`, which emits the same 62 rules and options.

| Bucket | Rules | Disposition |
| --- | --- | --- |
| In Oxlint's default `correctness` category (48) | `for-direction`, `no-async-promise-executor`, `no-class-assign`, `no-compare-neg-zero`, `no-cond-assign`, `no-constant-binary-expression`, `no-constant-condition`, `no-control-regex`, `no-debugger`, `no-delete-var`, `no-dupe-else-if`, `no-duplicate-case`, `no-empty-character-class`, `no-empty-pattern`, `no-empty-static-block`, `no-ex-assign`, `no-extra-boolean-cast`, `no-global-assign`, `no-invalid-regexp`, `no-irregular-whitespace`, `no-loss-of-precision`, `no-misleading-character-class`, `no-nonoctal-decimal-escape`, `no-self-assign`, `no-shadow-restricted-names`, `no-sparse-arrays`, `no-unsafe-finally`, `no-unsafe-optional-chaining`, `no-unused-labels`, `no-unused-private-class-members`, `no-useless-backreference`, `no-useless-catch`, `no-useless-escape`, `no-with`, `require-yield`, `use-isnan`, `valid-typeof`, `typescript/no-duplicate-enum-values`, `typescript/no-extra-non-null-assertion`, `typescript/no-misused-new`, `typescript/no-non-null-asserted-optional-chain`, `typescript/no-wrapper-object-types`, `typescript/prefer-as-const`, `typescript/triple-slash-reference` | Mapped; on by default, not listed in config |
| Mapped, must be enabled by name (14 + 4 import) | `no-case-declarations`, `no-fallthrough`, `no-regex-spaces`, `no-shadow` (warn; Oxlint uses the typescript-eslint flavour), `no-var`, `prefer-const`, `typescript/ban-ts-comment`, `typescript/consistent-type-imports`, `typescript/method-signature-style`, `typescript/no-inferrable-types`, `typescript/no-namespace`, `typescript/no-unsafe-function-type`, `typescript/prefer-for-of` (warn), `unicorn/prefer-node-protocol` (replaces `node/prefer-node-protocol`), `import/first`, `import/newline-after-import`, `import/no-commonjs`, `import/no-duplicates` | Mapped with the preset's options carried over |
| No Oxlint equivalent (3) | `no-octal` (moot under ES modules), `@typescript-eslint/naming-convention`, `@stylistic/spaced-comment` | Dropped; no JS-plugin bridge |
| Type-aware (3) | `@typescript-eslint/no-unnecessary-condition`, `no-unnecessary-type-assertion`, `no-for-in-array` | Dropped by decision; `tsc --noEmit` stays the type gate |
| Already off in every workspace (5) | `sort-imports`, `import/order`, `import/consistent-type-specifier-style`, `@typescript-eslint/array-type`, `@typescript-eslint/require-await` | Stay off. The inert `import/no-cycle` and `pnpm/json-enforce-catalog` overrides go with the ESLint configs |
| New: Oxlint default extras | `no-unused-vars` (with `_` ignore patterns), `no-unused-expressions`, `no-const-assign`, `no-dupe-keys`, `no-unreachable`, and the rest of `correctness` | Kept at error |
| New: React | `react/rules-of-hooks` error, `react/exhaustive-deps` warn, React Compiler rules warn | Adopted; 0 findings today. `react/only-export-components` stays off (36 hits on route and shadcn files) |
| New: jsx-a11y | `correctness` set minus `prefer-tag-over-role` | Adopted; 5 findings to fix |
| New: vitest | `no-focused-tests`, `no-identical-title`, `valid-expect`, `valid-title` error; `no-disabled-tests` warn | Adopted; 0 findings today |

## Known findings

Oxlint, 7 findings in 5 files, all real:

| File | Finding |
| --- | --- |
| `apps/dashboard/src/features/radar/data.ts:107` | 2 unused destructured variables (`start`, `avgVolume`) |
| `apps/dashboard/src/components/k/charts/candlestick-chart.tsx` | `jsx-a11y/no-static-element-interactions`, `jsx-a11y/no-noninteractive-tabindex` |
| `apps/dashboard/src/components/k/data-table.tsx:223` | `jsx-a11y/no-noninteractive-tabindex` |
| `apps/dashboard/src/features/radar/candidate-list.tsx` | `jsx-a11y/no-static-element-interactions` |
| `packages/ui/src/components/label.tsx:6` | `jsx-a11y/label-has-associated-control` (shadcn primitive; pass `htmlFor` through or allow with a reason) |

Oxfmt, 11 files change: `packages/ui/src/components/{dialog,dropdown-menu,select,sheet,sonner}.tsx` (already failing Prettier) and `apps/dashboard/src/components/k/{alert-rule,badge,data-table,empty-state,signal-card,status-pill}.tsx` (union-type layout only). `routeTree.gen.ts` files are ignored.

## Editor

`.vscode/extensions.json`:

```json
{ "recommendations": ["oxc.oxc-vscode"] }
```

`.vscode/settings.json` (per-language so format-on-save stays within the `ts`/`tsx` scope):

```json
{
  "editor.codeActionsOnSave": { "source.fixAll.oxc": "always" },
  "[typescript]": { "editor.defaultFormatter": "oxc.oxc-vscode", "editor.formatOnSave": true },
  "[typescriptreact]": { "editor.defaultFormatter": "oxc.oxc-vscode", "editor.formatOnSave": true }
}
```

The extension runs `oxlint --lsp` and `oxfmt --lsp` from the local install, so step 1 must land first.

## Upgrades

Pin exact versions. Oxlint's policy treats new rules and changed defaults in minor releases as non-breaking even when they surface new errors. Add a Renovate or Dependabot group for `oxlint` and `oxfmt` so upgrades arrive as reviewed PRs.

## Optional

Claude Code `PostToolUse` hook from the [oxc coding-agents guide](https://oxc.rs/docs/guide/usage/coding-agents.html), in `.claude/settings.json`, to lint-fix and format each edited file. Not required; `AGENTS.md` already instructs agents to run both tools.

## Out of scope

Pre-commit hooks; formatting CSS, JSON, and Markdown; type-aware lint rules; Vite Plus; swapping `tsc` for tsgolint (see [Research: tsgolint type-checking as a tsc replacement](https://github.com/apinrdw/kumora-monorepo/issues/11)).
