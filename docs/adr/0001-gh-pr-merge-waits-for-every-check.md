# gh pr merge waits for every check

The release branches' ruleset requires only the `e2e-evidence` status, and the `no-e2e-evidence` label passes it at once. So `gh pr merge --auto` merged apinrdw/kumora#291 while static, unit-tests and fallow were still pending. A merge-gate hook now holds `gh pr merge` until every check on the PR is green. When the hook itself hits a `gh` problem, it allows the command and prints a notice rather than blocking the merge.

Sites:
- `.claude/hooks/merge-gate.sh`

Source: apinrdw/kumora#291
