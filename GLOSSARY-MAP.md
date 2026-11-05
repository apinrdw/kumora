# Glossary map

This repo is multi-context. Each pnpm workspace owns its own `GLOSSARY.md` and `docs/adr/`. System-wide decisions live in `docs/adr/` at the root. See `docs/agents/domain.md` for how agents consume these.

| Context   | Workspace        | Purpose                                                                                           | Glossary                     | ADRs                       |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| Dashboard | `apps/dashboard` | The market terminal. Only its shell today, with no pages.     | `apps/dashboard/GLOSSARY.md` | `apps/dashboard/docs/adr/` |
| Web       | `apps/web`       | Public site. Starter landing page today.                                                          | `apps/web/GLOSSARY.md`       | `apps/web/docs/adr/`       |
| E2E       | `apps/e2e`       | Playwright smoke tests for both apps. No domain terms of its own.                                 | none                         | `docs/adr/`                |
| UI        | `packages/ui`    | Shared shadcn/ui components, hooks, and styles. Design-system vocabulary, no market domain terms. | `packages/ui/GLOSSARY.md`    | `packages/ui/docs/adr/`    |
