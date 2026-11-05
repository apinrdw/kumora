---
status: accepted
date: 2026-10-28
---

# Oxlint and Oxfmt replace ESLint and Prettier

Every workspace linted with `@tanstack/eslint-config` on ESLint 10 and formatted with Prettier plus `prettier-plugin-tailwindcss`; lint took about 4 seconds per workspace and CI never checked formatting. We replace both with Oxlint 1.90 and Oxfmt 0.75, installed directly as pinned root devDependencies with one `.oxlintrc.json` and one `.oxfmtrc.json` at the root, because the same rule set runs in 1.4 seconds for the whole repo, Oxfmt sorts Tailwind classes natively with output identical to the Prettier plugin, and the change stays confined to lint and format. The executable spec is [`docs/specs/lint-format-migration.md`](../specs/lint-format-migration.md); the decision trail is the wayfinder map [apinrdw/kumora-monorepo#3](https://github.com/apinrdw/kumora-monorepo/issues/3).

## Considered options

- **Vite Plus (`vp`) as the toolchain entry point.** Rejected for now. `vp lint` and `vp fmt` run the same binaries, but adoption re-aliases `vite` workspace-wide to VoidZero's wrapper, pins Vitest exactly, raises the Node floor, and adds a second task runner next to Turbo. The one-pass `vp check` speedup only materialises if tsgolint also replaces `tsc`. Nothing is foreclosed: `vp migrate` reads `.oxlintrc.json`.
- **Type-aware lint rules via tsgolint.** Dropped. The three type-aware preset rules go; `tsc --noEmit` stays the type gate. Research ([#11](https://github.com/apinrdw/kumora-monorepo/issues/11)) shows tsgolint already runs here and type-checks the repo in 0.8 seconds against 5.9 for `tsc`, but its type-check mode is experimental and only reports files Oxlint lints. Swapping the type-checker is a separate effort.
- **Bridging unmapped ESLint rules through Oxlint's JS plugins.** Rejected. Only `@typescript-eslint/naming-convention` (type-parameter casing) and `@stylistic/spaced-comment` would need it; not worth an alpha code path.

## Consequences

- Oxlint minor releases add rules and may change defaults without calling it breaking, so both tools are pinned to exact versions and upgraded through grouped dependency-bot PRs.
- Oxfmt's Tailwind sorting silently turns off if `sortTailwindcss.stylesheet` points at a missing file. That file is also the `@workspace/ui/globals.css` package export, so moving it already fails every app build; no extra guard is added.
- Multi-line union types gain a leading `|` per member (documented Oxfmt divergence from Prettier 3.9); six dashboard files are reformatted once.
- Coverage grows: Oxlint's default correctness rules, React hooks and React Compiler rules, jsx-a11y, and vitest rules are new. Seven findings exist today and are fixed in their own commit, separate from the reformat commit.
