# Briefing a subagent

What every implementer or reviewer brief in this repo carries. Copy the shape; fill the pointers.

## Pointers, not restatement

- The issue is claimed (`in-progress`, per **Claiming an issue** in `docs/agents/issue-tracker.md`) before the brief goes out; say so in the brief.
- The spec and ticket by command: `gh issue view <n>`. Name the sections of a spec doc the agent needs (for `docs/specs/*.md`, the config sections and **Gotchas**; the runbooks and provisioning sections are for humans) so it reads those and skips the rest.
- The exact config: the spec doc under `docs/specs/`, and the `Decision:` comments in the files the ticket touches.
- Repo rules: `AGENTS.md`. Review rules: `CODING_STANDARDS.md`.
- Shared notes for later agents: `/tmp/<repo>-notes/`, never the checkout. Ask the agent to leave one short file there with what the next ticket's implementer should reuse.

## Worktree guard

An isolated subagent's shell refuses any compound command it cannot prove stays inside its worktree. Tell it: run `git`, `pnpm`, `node`, `bun` and `infisical` as plain separate commands from the worktree root. No `&&` chains, `$(...)`, shell variables, `timeout`, or `HOME=` around them. One refusal costs a round trip and a rewrite; the three implementers of spec #59 hit 22 across 367 calls.

## Secrets

Never print a secret value; hash prefixes only. Never run `alchemy deploy` or `alchemy destroy` on a cloud stage, push a branch, or change a Cloudflare setting unless the brief says so.

## Done means

- The verify command or test the spec names passes, with the exact command and output in the report.
- From the repo root: `pnpm check`, which is what CI runs, and the lint and format commands in `AGENTS.md` exit 0.
- Small logical commits whose messages end with the attribution line the harness requires. Before reporting, merge the integration branch's current tip.

## Report

Branch, commit list, the verify output, each check's exit code, deviations from the spec, open concerns. Dev servers stopped.

## e2e in parallel

Each e2e run picks free dev server ports (`apps/e2e/support/ports.ts`), and its local state lives in its own worktree, so parallel implementers run `pnpm test:e2e` with no lock, as long as neither port variable (`DEV_PORT_VARIABLES` in `packages/deploy/src/target.ts`) is exported. CPU is the shared limit: give each run `--workers=<cores / runs>`. Two runs at 8 workers each on 16 cores timed out sign-in specs; at 4 each, both passed.
