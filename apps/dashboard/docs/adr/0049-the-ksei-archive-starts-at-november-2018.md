# The KSEI archive starts at November 2018

On 2026-11-15 the owner chose to keep the KSEI archive from November 2018 onward only, for both kinds. Production then held Statistik Efek 2008-01 to 2013-04 and Kepemilikan Efek 2008-04 to 2013-04 and 2018-01 to 2018-10, then a gap; those earlier reports were deleted once by hand, the one exception, since the code still deletes nothing. KSEI serves files back to 2008, so the deep backfill covers `FIRST_MONTH`'s year (2018) to 2023, and KSEI's rolling three-year listings, which the daily runs keep, cover November 2023 onward.

Sites:
- `apps/dashboard/src/server/ksei/coverage.ts`
- `apps/dashboard/src/server/ksei/keys.ts`
- `apps/dashboard/src/server/ksei/deep.ts`

Source: apinrdw/kumora#324
