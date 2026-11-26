# Production is reached by a Release that fast-forwards main

Publishing a GitHub Release, not pushing a tag, is what releases: the owner pushes a Release tag, `release.yml` judges it, and publishing a Release on it makes the release run fast-forward `main`. No PR reaches Production, because a merge commit on `main` would stop the fast-forward. For the same reason `staging` must contain all of `main`: a Sync PR (`main` into `staging`) moves only commits whose own PRs already passed the `e2e-evidence` gate.

Sites:

- `.github/workflows/release.yml`
- `.github/workflows/e2e-evidence.yml`
- `.github/workflows/sync-staging.yml`

Source: none
