# Oxlint and Oxfmt replace ESLint and Prettier

Oxlint and Oxfmt replace ESLint and Prettier: the same rule set lints the whole repo in 1.4 s, against about 4 s per workspace. Type-aware rules (tsgolint) were left off at first, because tsgolint's type-check mode was experimental, and `tsc --noEmit` was the type gate; ADR-0023 turned them on and moved the type gate to tsrs through `vp check`.

Vite Plus was deferred: it re-aliases `vite` and adds a second task runner.

Sites:

- `vite.config.ts`

Source: apinrdw/kumora-monorepo#3
