# Oxlint and Oxfmt are pinned and move by one grouped PR

Oxlint minors add rules and change defaults without calling it breaking, so a version range would fail CI unannounced. `oxlint` and `oxfmt` are pinned to exact versions in `package.json` and move only through one grouped Dependabot PR. Dependabot's `allow` limits version updates to these two packages; no other dependency gets PRs.

Sites:
- `.github/dependabot.yml`

Source: none
