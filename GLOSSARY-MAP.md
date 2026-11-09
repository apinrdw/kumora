# Glossary map

This repo is multi-context. Each pnpm workspace owns its own `GLOSSARY.md`. Decisions are `Decision:` comments in code, not ADRs. See `docs/agents/domain.md` for how agents consume these.

| Context   | Workspace        | Purpose                                                                                           | Glossary                     |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| Dashboard | `apps/dashboard` | The market terminal: the shell, sign-in and accounts, /account and the admin pages. | `apps/dashboard/GLOSSARY.md` |
| Web       | `apps/web`       | Public site. Starter landing page today.                                                          | `apps/web/GLOSSARY.md`       |
| E2E       | `apps/e2e`       | Playwright smoke tests for both apps. No domain terms of its own.                                 | none                         |
| Deploy    | `packages/deploy` | Branch to Stage, Worker names, the stack options and the deploy and teardown scripts. Deploy-time only. | `packages/deploy/GLOSSARY.md` |
| Client    | `packages/client` | The client runtime and the Day state store live rows read. Browser-side.                          | `packages/client/GLOSSARY.md` |
| Relay | `packages/relay` | What the relay extension and the dashboard Worker share: the IDX schedule and market phase, the ingest envelope, the viewer protocol version. | `packages/relay/GLOSSARY.md` |
| Server    | `packages/server` | The Effect bridge for server functions: `runServerEffect`, `WorkerEnv`, the HTTP errors. Server-only. | `packages/server/GLOSSARY.md` |
| UI        | `packages/ui`    | Shared shadcn/ui components, hooks, and styles. Design-system vocabulary, no market domain terms. | `packages/ui/GLOSSARY.md`    |
