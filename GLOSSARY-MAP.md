# Glossary map

This repo is multi-context. Each pnpm workspace owns its own `GLOSSARY.md` and `docs/adr/`. System-wide decisions live in `docs/adr/` at the root. See `docs/agents/domain.md` for how agents consume these.

| Context   | Workspace        | Purpose                                                                                           | Glossary                     | ADRs                       |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| Dashboard | `apps/dashboard` | The market terminal: Whale Radar and Whale Radar Live.      | `apps/dashboard/GLOSSARY.md` | `apps/dashboard/docs/adr/` |
| Web       | `apps/web`       | Public site. Starter landing page today.                                                          | `apps/web/GLOSSARY.md`       | `apps/web/docs/adr/`       |
| E2E       | `apps/e2e`       | Playwright smoke tests for both apps. No domain terms of its own.                                 | none                         | `docs/adr/`                |
| UI        | `packages/ui`    | Shared shadcn/ui components, hooks, and styles. Design-system vocabulary, no market domain terms. | `packages/ui/GLOSSARY.md`    | `packages/ui/docs/adr/`    |

## Shared terms

Terms used by more than one context. Context glossaries may refine these but should not contradict them.

- **Environment**: one of `dev` (local), `staging`, `prod`, the three Infisical environments. A Preview reads `staging`. See ADR-0003.
- **Staging Worker**: the persistent `kumora-<app>-staging` Worker that `main` deploys to; Wrangler's `env.staging`.
- **Preview**: a Workers Preview of a staging Worker, built per branch, with its own URL. It reads secrets from the **Previews base config**, never from the Worker. _Avoid_: preview deployment, version preview.
- **Trade**: one executed match on the exchange for a symbol: its time, price, volume in shares, and whether the taker bought or sold. _Avoid_: Running trade, print, transaction, done
- **Relay**: the service that keeps the current session's tape and serves it live to the operator's dashboard sessions, from whichever source is active.
- **Source**: where the relay is taking trades from right now: its own session, or the extension. At most one source is active; the relay chooses. _Avoid_: Primary, fallback (for a source)
- **Ingest**: one extension socket into the relay, after its auth. An install keeps one ingest. Its reconnect opens a new one; when the old one is the active ingest, the new one takes over once it reports a datafeed, and the old one is closed with 4003. ADR 0004's "default ingest" and "alternative ingest" predate this entry and mean a source.
- **Active ingest**: the ingest the relay takes trades from while the extension is the source. _Avoid_: Holder (an ownership word, as in **Holder position** in `apps/dashboard/GLOSSARY.md`)
- **Own session**: the upstream session the relay itself holds, on a pair the extension pushes. Off by default, behind a switch. _Avoid_: Upstream, for the relay's session alone
- **Sync**: an Infisical native Cloudflare Workers secret sync from one environment and folder to one Worker. Infisical is the source; Cloudflare holds copies.
