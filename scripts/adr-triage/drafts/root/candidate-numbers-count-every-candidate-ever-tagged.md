# Candidate numbers count every Candidate ever tagged

A Candidate tag is `v<version>-<YYYYMMDD>-<N>`. `N` counts every Candidate ever tagged, whatever its date or version, so it never resets when the day changes. A refused Release or tag is deleted, so it never counts toward the next Candidate's `N` or the version Production must exceed; a Release refused on a Candidate keeps that Candidate's tag. A tag's date is the day it is pushed in WIB, the owner's day.

Sites:
- `scripts/release-tag.mts`
- `.github/workflows/release.yml`
