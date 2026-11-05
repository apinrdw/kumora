# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** at the repo root for system-wide decisions.
- **`<context>/docs/adr/`** for context-scoped decisions, where `<context>` is a workspace listed in `GLOSSARY-MAP.md` (e.g. `apps/dashboard/docs/adr/`).

If a context's `GLOSSARY.md` or ADR directory doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **multi-context** repo. Contexts are the pnpm workspaces under `apps/*` and `packages/*`.

```
/
├── GLOSSARY-MAP.md                    ← index of contexts
├── docs/adr/                          ← system-wide decisions
├── apps/
│   ├── dashboard/
│   │   ├── GLOSSARY.md
│   │   └── docs/adr/                  ← dashboard-specific decisions
│   └── web/
│       ├── GLOSSARY.md
│       └── docs/adr/
└── packages/
    └── ui/
        ├── GLOSSARY.md
        └── docs/adr/
```

A term shared by more than one context belongs in the system-wide section of `GLOSSARY-MAP.md`, not duplicated per context. When a new workspace is added, add a row to `GLOSSARY-MAP.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
