# Glossary map

This repo is multi-context. Each pnpm workspace owns its own `GLOSSARY.md` and `docs/adr/`. System-wide decisions live in `docs/adr/` at the root. See `docs/agents/domain.md` for how agents consume these.

| Context   | Workspace        | Purpose                                                                                           | Glossary                     | ADRs                       |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| Dashboard | `apps/dashboard` | The market terminal. Only its shell today, with no pages.     | `apps/dashboard/GLOSSARY.md` | `apps/dashboard/docs/adr/` |
| Web       | `apps/web`       | Public site. Starter landing page today.                                                          | `apps/web/GLOSSARY.md`       | `apps/web/docs/adr/`       |
| E2E       | `apps/e2e`       | Playwright smoke tests for both apps. No domain terms of its own.                                 | none                         | `docs/adr/`                |
| UI        | `packages/ui`    | Shared shadcn/ui components, hooks, and styles. Design-system vocabulary, no market domain terms. | `packages/ui/GLOSSARY.md`    | `packages/ui/docs/adr/`    |

## Shared terms

Terms used by more than one context. Context glossaries may refine these but should not contradict them.

- **Environment**: one of `dev` (local), `staging`, `prod`, the three Infisical environments. A Preview reads `staging`. See ADR-0003.
- **Staging Worker**: the persistent `kumora-<app>-staging` Worker that `main` deploys to; Wrangler's `env.staging`.
- **Preview**: a Workers Preview of a staging Worker, built per branch, with its own URL. It reads secrets from the **Previews base config**, never from the Worker. _Avoid_: preview deployment, version preview.
- **Sync**: an Infisical native Cloudflare Workers secret sync from one environment and folder to one Worker. Infisical is the source; Cloudflare holds copies.
