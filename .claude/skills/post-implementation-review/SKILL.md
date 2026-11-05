---
name: post-implementation-review
description: Review and verify a finished integration branch before its PR is marked ready. Use when /mattpocock-skills:implement-spec completes, or when asked to review, verify or gate a branch before merge.
---

# Post-implementation review

You own the gate: implementers fix, Codex and fallow review, and you verify what each claims. The branch is the PR's integration branch (for implement-spec, the one its draft PR points at). Two phases run in order: the **review loop** until _clean_, then **verification** on the real artifact.

## 1. Pin the target

Work from a worktree on the integration branch; Codex reviews the `HEAD` of its working directory. Done when `git status` is clean and `HEAD` equals `origin/<branch>`.

## 2. Review loop

Each round runs three reviews in parallel from the worktree, each saved to a file:

1. **Codex.** As a background Bash task, run the Codex plugin's companion script (under `~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`) with `review --wait --base origin/main`. Read the `# Codex Review` section only.
2. **fallow.** `fallow audit --format json --quiet --base origin/main`, stdout to the file and stderr apart. Exit 0 is clean; exit 1 has findings; any other code is a setup failure to fix before the round counts. Findings with `introduced: true` go to the fix, inherited ones to the report.
3. **Domain and standards.** One fresh subagent, briefed with `git diff origin/main...HEAD`, the spec, [`CODING_STANDARDS.md`](../../../CODING_STANDARDS.md), and the touched workspaces' `GLOSSARY.md` (rows of [`GLOSSARY-MAP.md`](../../../GLOSSARY-MAP.md)) and the `Decision:` comments in the touched files alone: report each hunk that names a domain thing by a word the glossary gives another word for, that contradicts a `Decision:` comment or deletes one without its decision changing, or that breaks a standard, citing the term, the decision, or the rule, or `none`. Codex's review takes no instructions, so this pass is where the domain docs and the standards are enforced.

_Clean_ is all of these on the current `HEAD`: Codex reports no actionable regressions and no comments, fallow exits 0, the domain pass reports `none`, and the PR's `check` job from `gh pr checks` is green. Clean ends the loop; go to section 3.

A domain item that changes only comments or docs needs no new round: fix it, push, and rerun the domain pass and the `check` job. Codex's verdict carries over only when `git diff` since the commit it reviewed touches nothing but comments and docs. Otherwise:

4. **Triage.** A finding that turns on a product or security trade-off (what a page may reveal, what an attacker can reach) is the owner's call: ask as `AGENTS.md` describes, recommended option first, and brief the answer. Everything else goes to the fix.
5. **Fix.** Send the round's findings to one fresh `pstack:poteto-agent` (the strongest-judgment model when a finding is security) with file pointers: the Codex output, the fallow JSON, the domain report, the spec, earlier fix commits. The brief requires, per finding, a check that goes _red_ on the finding, committed and pushed before the commit that turns it _green_ (for a fallow finding the audit is the check: fix the code, or `fallow-ignore` with a reason only for a false positive, syntax in the `fallow:fallow` skill); the spec and the PR body draft amended to match; `pnpm check` and the lint and format commands in `AGENTS.md` passing; new commits on top of the branch, so the PR history only grows.
6. **Read the diff yourself**, then start the next round at step 1.

## 3. Verification

Load `pstack:poteto-mode` and verify as an independent reviewer of everything the implementers reported. Every claim in the final reply is a number or output you observed this session.

1. **Scope.** List the touched workspaces from `git diff --name-only origin/main...HEAD` against `pnpm-workspace.yaml`; a change under `packages/*` touches every app that depends on it. For each, read `workspaces/<name>.md` in this folder when it exists: the setup that cost time to find for that workspace. Done when every touched workspace is listed with its setup source.
2. **Gates, once from the root.** `pnpm install --frozen-lockfile`, `pnpm check`, the lint and format commands in `AGENTS.md`, and any grep check the spec names. Done when each exit code and any known-failure list is recorded.
3. **Servers, per touched app.** Run its `dev` script (`bun alchemy dev`, fully local), and `pnpm test:e2e`; the deployed build is the PR's Workers Builds preview, checked with the runbook's `/probe` step. Drive the changed flows in the browser against each, and run any check the spec names. Record pass and fail counts. A failure on an unfamiliar surface suspects the observation first: read the check's header for the setup it requires.
4. **Plant each defect.** For each fix made in this run, put its defect back (revert the guard, re-enable the path) and rerun the check that covers it. Done when each plant fails with the assertion that names the defect, quoted, and the tree is clean again.
5. **Record the setup.** Setup that cost time to find for a workspace (a server flag, a port, a probe command) goes into its `workspaces/<name>.md`, created when missing. Cache only what the workspace's own files and `--help` output do not tell.
6. **Report.** Read each review's output in an earlier call than any command that posts about it. Sync the PR body from its draft, then report per workspace: what ran, the counts, the planted-defect assertions, the owner steps left.
