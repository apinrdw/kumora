# Briefing a subagent

What every implementer or reviewer brief in this repo carries. Copy the shape; fill the pointers.

## Pointers, not restatement

- The issue is claimed (`in-progress`, per **Claiming an issue** in `docs/agents/issue-tracker.md`) before the brief goes out; say so in the brief.
- The spec and ticket by command: `gh issue view <n>`. Name the sections of a spec doc the agent needs (for `docs/specs/*.md`, the config sections and **Gotchas**; the runbooks and provisioning sections are for humans) so it reads those and skips the rest.
- The exact config: the spec doc under `docs/specs/`, and the `Decision:` comments in the files the ticket touches.
- Repo rules: `AGENTS.md`. Review rules: `CODING_STANDARDS.md`.
- Shared notes for later agents: `/tmp/<repo>-notes/`, never the checkout. Ask the agent to leave one short file there with what the next ticket's implementer should reuse.

## Worktree guard

An isolated subagent's shell refuses any command it cannot prove stays inside its worktree. Tell it:

- One command per Bash call, run where the shell starts: the worktree root.
- Create and change files with the Write and Edit tools.
- The command itself is plain too: no `$(...)`, shell variables, `timeout`, or `VAR=` prefix.

Each refusal costs a round trip and a rewrite. Spec #59's three implementers hit 22 across 367 calls. Spec #175's sixteen implementers and fixers hit 39 across 1,059 calls, most from `;` chains, a `cd <worktree>;` prefix, and heredocs into `cat` or `python3`.

## Secrets

Never print a secret value; hash prefixes only. Never run `alchemy deploy` or `alchemy destroy` on a cloud stage, push a branch, or change a Cloudflare setting unless the brief says so.

## Done means

- The verify command or test the spec names passes, with the exact command and output in the report.
- From the repo root: `pnpm check`, which is what CI runs, and the lint and format commands in `AGENTS.md` exit 0.
- A test the change adds, moves or reruns differently also passes on CI's 2 cores: rerun the affected suite under `taskset -c 0,1`, giving Playwright CI's worker count with `--workers`: the `workers` that `apps/e2e/playwright.config.ts` sets for CI, else 1, its default on CI's 2 cores. Locally its default counts every core even under `taskset`. In spec #175, Vitest's 5 s and Playwright's 30 s default timeouts held locally and failed only on CI.
- A new entry file, such as a `scripts/*.mts` that a command runs, lands in the same commit as the `package.json` script that runs it. Until then fallow's commit gate blocks it as an unused file.
- Small logical commits whose messages end with the attribution line the harness requires. Before reporting, merge the integration branch's current tip.

## Report

Branch, commit list, the verify output, each check's exit code, deviations from the spec, open concerns. Dev servers stopped.

## e2e in parallel

Ports are per run (`apps/e2e/support/ports.ts` says how a preset one is treated) and local state is per worktree, so parallel implementers run `pnpm test:e2e` with no lock. CPU is the shared limit: give each run `--workers=<cores / runs>`. Two runs at 8 workers each on 16 cores timed out sign-in specs; at 4 each, both passed.
