## Agent skills

### Issue tracker

Issues live in GitHub Issues for `apinrdw/kumora`, operated via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: root `GLOSSARY-MAP.md` indexes one `GLOSSARY.md` per pnpm workspace (`apps/*`, `packages/*`). See `docs/agents/domain.md`.

### Decisions

No ADRs. A decision lives as a `Decision:` comment on the line that enacts it, and a decision with no code site goes in the config file that enacts it. Read `Decision:` comments in a file before changing it, and keep them through `/no-comments` and `/deslop`. See **Decisions live in code, not ADRs** in `docs/agents/domain.md`.

### Deploys

Nothing deploys yet. `kumora` started as a fresh-history copy of `apinrdw/kumora-monorepo` with no Workers, Infisical project or Workers Builds connected.

### Briefing a subagent

Before writing an `Agent` prompt for an implementer or reviewer, read `docs/agents/subagent-brief.md`.

### Finishing a spec

When `/mattpocock-skills:implement-spec` completes, run the `post-implementation-review` skill before marking its PR ready.

### Turborepo

Before changing `turbo.json` or a turbo command, read `docs/README.md` in the installed `turbo` package (`node -p "require.resolve('turbo/package.json')"`), then the relevant `docs/` pages. They match the installed version.

### Pull requests

Before writing a PR body (opening a PR or rewriting one), invoke the `/mattpocock-skills:pr` skill and follow its template. Keep the attribution line your harness requires at the end.

## Asking the user

- When a question has enumerable answers, present the options as a selection prompt if your harness has one.
- When you have a preference, mark that option as recommended and list it first.
- Batch every question that can be answered now into one prompt, up to the tool's limit. Use multi-select when choices are not exclusive. A question that depends on an open answer waits for the next round.
- Without a selection tool, ask as a numbered list, recommended option first and marked, ending with "or reply with your own answer".
- A skill that prescribes its own question format keeps it.
- In an unattended run, do not ask. Take the recommended option, keep working, and state the assumption in the final message.

## Linting and formatting

Oxlint and Oxfmt, configured once at the repo root (`.oxlintrc.json`, `.oxfmtrc.json`). Run from the repo root.

- After making code changes, run `pnpm exec oxlint --fix`, then `pnpm exec oxfmt 'apps/**/*.{ts,tsx}' 'packages/**/*.{ts,tsx}' 'scripts/**/*.mts'`. `--fix` applies only safe fixes; do not add `--fix-suggestions` or `--fix-dangerously`.
- Before finishing, run `pnpm exec oxlint --deny-warnings --format=agent` and `pnpm exec oxfmt --check 'apps/**/*.{ts,tsx}' 'packages/**/*.{ts,tsx}' 'scripts/**/*.mts'`. Both must exit 0; warnings count as failures.
- Generated files (`routeTree.gen.ts`) are ignored by both tools. Do not add inline ignore comments to silence a rule; fix the code or raise it.
- `scripts/check-skill-links.mts` fails on a relative link in `AGENTS.md` or any `SKILL.md` under `.claude/skills/` whose target is missing. CI runs it.
