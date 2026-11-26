---
Status: superseded by ADR-0022
---

# Oxlint and Oxfmt replace ESLint and Prettier

Oxlint and Oxfmt replace ESLint and Prettier: the same rule set lints the whole repo in 1.4 s, against about 4 s per workspace. Type-aware rules (tsgolint) are off, because tsgolint's type-check mode is experimental, so `tsc --noEmit` stays the type gate.

Vite Plus was deferred: it re-aliases `vite` and adds a second task runner.

Sites:

- `vite.config.ts`

Source: apinrdw/kumora-monorepo#3
