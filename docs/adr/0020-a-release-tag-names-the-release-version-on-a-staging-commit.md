# A Release tag names the Release version on a staging commit

Every merge into `staging` deploys to Staging, so every `staging` commit is already up for release; the numbered Candidate tag (`v<version>-<YYYYMMDD>-<N>`, ADR-0008) added a step and named nothing new. It is retired: `release.yml` now refuses a new `-<N>` tag, and the 66 old ones were deleted on 2026-11-26, none carrying a Release. To release, the owner bumps the Release version, `version` in the root, `apps/dashboard` and `apps/web` `package.json`, on `staging`, pushes a Release tag `v<version>-<YYYYMMDD>` on a `staging` commit, then publishes a GitHub Release on that tag. The tag is kept only when its version equals the Release version at its commit, is above Production's (the highest Release tag on `main`), and is dated today in WIB; a refused tag is deleted. A Release is judged again without the date, since it may come days after its tag, and a refused Release is deleted while its tag stays and deploys nothing. Tying the tag to `package.json` makes the shipped version readable in the code, and a CI check keeps the three files equal so a missed file fails on its PR, not at release.

Sites:

- `scripts/release-tag.mts`
- `.github/workflows/release.yml`

Source: none
