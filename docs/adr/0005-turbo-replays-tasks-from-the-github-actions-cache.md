# Turbo replays tasks from the GitHub Actions cache

CI's turbo replays tasks from the GitHub Actions cache. It needs no secret, and GitHub scopes cache entries by ref, so a PR reads `main`'s entries and its own while `main` never replays a PR's. The cache action is pinned to a commit (v2.5.2) because it holds the runner's cache token, and the unit-tests job pins the same commit.

Sites:

- `.github/workflows/ci.yml`

Source: none
