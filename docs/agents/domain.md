# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`Decision:` comments** in the files you are about to change: `rg 'Decision:' <path>`. They hold the choices a change could quietly undo.

If a context's `GLOSSARY.md` doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when a term actually gets resolved.

## File structure

This is a **multi-context** repo. Contexts are the pnpm workspaces under `apps/*` and `packages/*`.

```
/
├── GLOSSARY-MAP.md                    ← index of contexts
├── apps/
│   ├── dashboard/
│   │   └── GLOSSARY.md
│   └── web/
│       └── GLOSSARY.md
└── packages/
    ├── deploy/
    │   └── GLOSSARY.md
    ├── server/
    │   └── GLOSSARY.md
    └── ui/
        └── GLOSSARY.md
```

A term shared by more than one context belongs in the system-wide section of `GLOSSARY-MAP.md`, not duplicated per context. When a new workspace is added, add a row to `GLOSSARY-MAP.md`.

## Decisions live in code, not ADRs

This repo keeps no ADRs. A decision is recorded as a comment at the line that enacts it, and `scripts/check-decision-docs.mts` fails CI if an ADR directory or a link to one comes back.

- **Where.** On the code or config line that would change if the decision were reversed. A decision with no single code site (a platform or tool choice) goes in the config file that enacts it: `.oxlintrc.json`, `.fallowrc.jsonc`, `pnpm-workspace.yaml`.
- **Tag.** Start the comment with `Decision:` in the file's comment syntax (`// Decision:`, `# Decision:`). The tag tells `/no-comments`, `/deslop` and reviewers to keep it, and makes every decision greppable.
- **Content.** The choice, the constraint it puts on the code, and in one clause the main option it beat and why. Link the wayfinder ticket or PR for the full trade-off. Keep it to five lines at most, from the tag to the first empty comment line or code line; the tracker holds the rest. `scripts/check-decision-docs.mts` fails a longer one, and one whose tag sits partway along a comment line.
- **When.** Only for a choice that is hard to reverse, surprising without context, and the result of a real trade-off. Anything else needs no comment.

When `/domain-modeling` says to offer or write an ADR, write a `Decision:` comment instead. When a change makes a `Decision:` comment false, update or delete it in the same commit.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts a `Decision:` comment, surface it explicitly rather than silently overriding:

> _Contradicts the `Decision:` in `.oxlintrc.json` (no type-aware rules), but worth reopening because…_
