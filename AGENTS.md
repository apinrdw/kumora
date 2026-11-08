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

Alchemy deploys `apps/web` and `apps/dashboard` through Workers Builds: `main` to production, `staging` to staging, every other branch to its own preview stage. Each app's stack is its `alchemy.run.ts`; the stage logic, Worker names and deploy script live in `packages/deploy` (see its `GLOSSARY.md`). `.github/workflows/teardown-preview.yml` destroys a preview when its PR closes or its branch is deleted. Secrets come from the Infisical project `kumora`. `pnpm dev` runs both apps fully locally with `bun alchemy dev`. The human steps are in `docs/runbooks/deploy.md`.

### Vendored references

`repos/effect` and `repos/alchemy` are read-only `git subtree --squash` copies of the installed Effect and Alchemy versions.

- Read `repos/effect/LLMS.md` before writing Effect code. Consult `repos/alchemy` for Alchemy resources and props.
- Never edit `repos/`, and never import from it. Lint rejects the import.
- The `effect` and `alchemy` versions live once, in the `pnpm-workspace.yaml` catalog. A PR that bumps either also runs `git subtree pull --prefix repos/<name> <url> <tag> --squash` to the matching tag. Alchemy's subtree brings back its `submodules/*` entries, which break the Workers Builds clone: drop them with `git rm --cached`; `scripts/check-no-gitlinks.mts` fails until you do.
- After any filtered `pnpm --filter <pkg> add`, run a full `pnpm install`: a filtered add links only that package and the root, which leaves the other workspaces unresolved.

### Briefing a subagent

Before writing an `Agent` prompt for an implementer or reviewer, read `docs/agents/subagent-brief.md`.

### Finishing a spec

When `/mattpocock-skills:implement-spec` completes, run the `post-implementation-review` skill before marking its PR ready.

### Turborepo

Before changing `turbo.json` or a turbo command, read `docs/README.md` in the installed `turbo` package (`node -p "require.resolve('turbo/package.json')"`), then the relevant `docs/` pages. They match the installed version.

### Pull requests

Before writing a PR body (opening a PR or rewriting one), invoke the `/mattpocock-skills:pr` skill and follow its template. Keep the attribution line your harness requires at the end.

## Asking the user

- Always ask through the harness's selection prompt (such as `AskUserQuestion`) when it has one. This overrides any skill's own question format: a skill like `grilling` that prescribes numbered rounds in chat still asks each round through the selection prompt.
- When you have a preference, mark that option as recommended and list it first.
- Batch every question that can be answered now into one prompt, up to the tool's limit. Use multi-select when choices are not exclusive. A question that depends on an open answer waits for the next round.
- Without a selection tool, ask as a numbered list, recommended option first and marked, ending with "or reply with your own answer".
- In an unattended run, do not ask. Take the recommended option, keep working, and state the assumption in the final message.

## Linting and formatting

Oxlint and Oxfmt, configured once at the repo root (`.oxlintrc.json`, `.oxfmtrc.json`). Run from the repo root.

- After making code changes, run `pnpm exec oxlint --disable-nested-config --fix`, then `pnpm exec oxfmt 'apps/**/*.{ts,tsx}' 'packages/**/*.{ts,tsx}' 'scripts/**/*.mts'`. `--fix` applies only safe fixes; do not add `--fix-suggestions` or `--fix-dangerously`.
- Before finishing, run `pnpm exec oxlint --disable-nested-config --deny-warnings --format=agent` and `pnpm exec oxfmt --check 'apps/**/*.{ts,tsx}' 'packages/**/*.{ts,tsx}' 'scripts/**/*.mts'`. Both must exit 0; warnings count as failures.
- `--disable-nested-config` keeps oxlint from loading the vendored configs under `repos/`, which it ignores. Generated files (`routeTree.gen.ts`) are ignored by both tools. Do not add inline ignore comments to silence a rule; fix the code or raise it.
- `scripts/check-skill-links.mts` fails on a relative link in `AGENTS.md` or any `SKILL.md` under `.claude/skills/` whose target is missing. CI runs it.

---

<!-- fallow:setup-hooks:start -->
## Fallow checks

Use fallow for code-quality, cleanup, and setup tasks in this repository. Fallow checks the changed code before each `git commit` and `git push`. In Claude Code and Codex, a PreToolUse hook from `fallow agent install` runs this check and blocks the command when the verdict is `fail`. Other agents run the check themselves: `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before you try again. A JSON runtime error such as `{ "error": true, ... }` does not block.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to... | Run |
|---|---|
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| prove a TypeScript symbol's exact consumers before refactoring | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>` |
| find how one module reaches another | `fallow trace --path <from> <to>` (Reports `reachable: false` instead of failing when no import path exists; type-only hops are reported, not skipped.) |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| migrate a dependency | `fallow trace --dependency <name> --sites` (Counts each imported name, follows one hop through project wrappers, and counts each use that it cannot resolve.) |
| commit or open a PR | `fallow audit --base <ref>` |
| read a diff before approving it | `fallow review --base <ref> --brief` (orientation, never gates: deterministic and always exit 0, unlike the audit row) |
| prioritize refactoring | `fallow health --hotspots --targets` |
| ask who owns code | `fallow health --ownership` |
| check untested-but-reachable code | `fallow health --coverage-gaps` |
| consolidate duplication | `fallow dupes --trace dup:<fingerprint>` |
| find feature flags | `fallow flags` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| check import cycles, boundaries and policy rules after changing code | `fallow architecture` |
| surface security candidates | `fallow security` |
| understand a finding | `fallow explain <issue-type>` |
| scope a monorepo | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |
<!-- fallow:setup-hooks:end -->
