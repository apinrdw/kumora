# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY-MAP.md`** at the repo root: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`Decision:` pointers** in the files you are about to change (`rg 'Decision:' <path>`), and the ADRs they name. They hold the choices a change could quietly undo.

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

## Decisions are ADRs

A decision that clears the bar is an ADR, and each line that enacts it carries a `Decision:` pointer to that ADR. Any other choice gets a plain why-comment, or nothing. `scripts/check-decision-docs.mts` enforces the pointer, path and numbering rules below.

- **The bar.** A choice clears it when undoing it reaches beyond its line, meaning it does at least one of these:
  - binds more than one site, across files or packages;
  - shapes data that is stored or sent, so old data or deployed clients outlive a change;
  - guards Production data or a platform limit;
  - fixes a tool, platform or process the whole repo depends on.

  A choice local to one function, component, constant or test stays a why-comment, however surprising it is. The comment at the site already stops a reader from "fixing" it.

- **Where.** A decision of one workspace goes in that workspace's `docs/adr/`. Root scripts and root config (`scripts/`, `.github/`, `turbo.json`, `pnpm-workspace.yaml`) and system-wide decisions go in the root `docs/adr/`. A decision enacted in several workspaces goes in the lowest context every site depends on, even when that context has no enacting line of its own: the token refusal shared by `apps/extension` and `apps/dashboard` goes in `packages/relay`. When no workspace is shared by all the sites, it goes in the root. Create a directory when its first ADR is written, glossary or not, and name it in the ADRs column of `GLOSSARY-MAP.md`.
- **Format.** `/domain-modeling`'s ADR format, named `NNNN-slug.md` with the next free number in its directory: a title, then a short paragraph of the context, the choice and the reason. It ends with a `Sites:` list of the files whose pointer names it, then a `Source:` line naming its issue or PR, or `Source: none`; the checker holds both. Frontmatter may carry `Status`, and `Sites: none` for a decision with no code or config line that can take a pointer. A D1 migration cannot: Alchemy refuses to deploy an applied one edited even in a comment, and the checker reads no SQL, so a decision enacted only in migrations names them in its body and declares `Sites: none`.
- **Pointer.** A gist, then the ADR's path from the repo root, in at most two comment lines. It uses the file's comment syntax and opens its own comment line, not one that follows code:

  ```ts
  // Decision: 401 refuses the token, 426 means reload the extension
  // (packages/relay/docs/adr/NNNN-token-refusal.md)
  ```

  One decision gets one ADR, with the same pointer at each enacting site. The checker (`scripts/decision-docs.mts`) names the file types whose comments it reads, and it reads `docs/adr/` links in every tracked file. `Decision:` lines in Markdown under `docs/research/` and `docs/runbooks/`, and in D1 migrations (`*.sql`), are dated records and keep their wording.

- **Writing.** Write the ADR and its pointers in the same commit as the code, without asking first, and list the ADR under the PR body's `Decisions` heading.
- **Changing.** A refinement, or a new site, edits the ADR in place. A reversal writes a new ADR, sets the old one's `Status` to `superseded by ADR-NNNN`, and moves every pointer to the new one; the checker fails a pointer left behind. When a change makes a why-comment false, update or delete it in the same commit.
- **Number clash.** When another branch lands the same number in the directory first, the checker fails yours on `staging`. Renumber your ADR and update its pointers.
- **Pruning.** `/no-comments` and `/deslop` keep a `Decision:` pointer while its ADR holds. A plain why-comment is pruned on its merits, like any comment.

`/domain-modeling` writes ADRs as its format describes, against this bar. Where it says to offer an ADR, write it instead.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the relevant `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts an ADR, surface it explicitly rather than silently overriding:

> _Contradicts the ADR behind the `Decision:` in `vite.config.ts` (no type-aware rules), but worth reopening because…_
