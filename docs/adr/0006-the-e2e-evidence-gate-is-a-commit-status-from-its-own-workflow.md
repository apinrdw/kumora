# The e2e-evidence gate is a commit status from its own workflow

A PR that touches app code must show a recorded e2e run before it merges. The gate is an `e2e-evidence` commit status: red until evidence, green for a PR with no app code or with the `no-e2e-evidence` label. `vp run e2e:evidence` sets the success with the author's own `gh` login, because only a GitHub App can create a check run. The gate never touches a success someone else set, and recomputes only its own, so removing the label or retargeting can turn it red. Its job is named differently from the status, so the job's green check run can't satisfy a ruleset on `e2e-evidence`.

The gate is its own workflow, not a job in `ci.yml` as apinrdw/kumora#203 planned: in `ci.yml` a label event would cancel the running checks through its concurrency group and replace their results with skipped check runs on the head. It runs on `pull_request_target`, because `pull_request`'s token is read-only by default on a Dependabot or fork PR and the status write would 403. That is safe only while no step checks out or runs PR code and the script takes no `${{ }}` input. GitHub runs the base branch's copy, so a PR that adds or edits the workflow runs the old copy or none.

Sites:
- `.github/workflows/e2e-evidence.yml`
- `scripts/e2e-evidence-plan.mts`

Source: apinrdw/kumora#203, apinrdw/kumora#211
