# Briefing a subagent

What every implementer or reviewer brief in this repo carries. Copy the shape; fill the pointers.

## Pointers, not restatement

- The issue is claimed (`in-progress`, per **Claiming an issue** in `docs/agents/issue-tracker.md`) before the brief goes out; say so in the brief.
- The spec and ticket by command: `gh issue view <n>`. Name the sections of a spec doc the agent needs (for `docs/specs/*.md`, the config sections and **Gotchas**; the runbooks and provisioning sections are for humans) so it reads those and skips the rest.
- The exact config: the spec doc under `docs/specs/`.
- The decisions: the `Decision:` pointers in the files the ticket touches, and the ADRs they name.
- Repo rules: `AGENTS.md`. Review rules: `CODING_STANDARDS.md`.
- Shared notes for later agents: `~/.t3/notes/<repo>/<spec>/`, never the checkout or `/tmp` (a tmpfs here: a reboot during spec #244 wiped its notes before the retro read them). Ask the agent to leave one short file there with what the next ticket's implementer should reuse. A read-only agent (`Explore`, `Plan`) cannot write files: ask it to return the notes in its report, and save them yourself.

## Worktree guard

An isolated subagent's shell refuses any command it cannot prove stays inside its worktree. Tell it:

- Each `git` command gets a Bash call of its own, run where the shell starts: the worktree root. A `git` command in a chain or loop (`&&`, `;`, `for`, a `cd <worktree> &&` prefix) is refused, and so is the same chain retried with a `cd` in front.
- Create and change files with the Write and Edit tools. For an edit too big for Edit (many replacements, a rename across files), Write a script to the scratchpad and run it as `python3 <path>`, which passes. A heredoc (`python3 - <<EOF`, `cat > f <<EOF`) is refused.
- The command itself is plain too: no `$(...)`, shell variables, `timeout`, or `VAR=` prefix.
- A check you ask for prints its answer. For "based on the integration branch", give `git rev-list --count HEAD..origin/<branch>` (`0` means yes), not `git merge-base --is-ancestor`, which answers only in its exit code: agents append `; echo $?` to read it and are refused. That was 16 of spec #244's 33 refusals.

Each refusal costs a round trip and a rewrite. Spec #175's sixteen implementers and fixers hit 39 across 1,059 calls. Specs #303 and #327 hit 30 across 72 agents, even with this list in every brief: half were heredoc edits into `python3`, the rest `git` in a chain.

## Secrets

Never print a secret value; hash prefixes only. Never run `alchemy deploy` or `alchemy destroy` on a cloud stage, push a branch, or change a Cloudflare setting unless the brief says so.

## Done means

- The verify command or test the spec names passes, with the exact command and output in the report.
- From the repo root: `pnpm check`, which is what CI runs, and the lint and format commands in `AGENTS.md` exit 0.
- A Vitest test that is slow on purpose sets its own `timeout`. The local default is 2.5 s, half CI's (`vitest.timeout.mts`), so a test that would time out on CI's 2 cores times out here first.
- An e2e change passes `pnpm test:e2e`, which runs only on the dev machine. A per-ticket implementer inside an implement-spec run posts no evidence; `post-implementation-review` runs `pnpm e2e:evidence` on the integration PR.
- A new entry file, such as a `scripts/*.mts` that a command runs, lands in the same commit as the `package.json` script that runs it. Until then fallow's commit gate blocks it as an unused file.
- A name is exported only when another file imports it in the same commit. An export kept for a test that doesn't exist yet, or for a later ticket, led every one of specs #303 and #327's 13 commit-gate blocks.
- Small logical commits whose messages end with the attribution line the harness requires. Before reporting, merge the integration branch's current tip.

## Report

Branch, commit list, the verify output, each check's exit code, deviations from the spec, open concerns. Dev servers stopped.

## e2e in parallel

Ports are per run (`apps/e2e/support/ports.ts` says how a preset one is treated) and local state is per worktree, so parallel implementers run `pnpm test:e2e` with no lock. CPU is the shared limit: give each run `--workers=<cores / runs>`. Two runs at 8 workers each on 16 cores timed out sign-in specs; at 4 each, both passed.
