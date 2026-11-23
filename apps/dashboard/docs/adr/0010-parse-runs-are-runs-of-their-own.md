# Parse runs are runs of their own

The shareholding and KSEI parses run as crons of their own, not as steps of their archive runs. A parse reads only R2 and HoldingsDb, so a parse failure no longer makes an archive run partial, parsing needs no IDX listing, and the KSEI parse runs an hour after the KSEI archive, apart from KSEI's availability.

Sites:
- `apps/dashboard/src/server/shareholding/schedule.ts`
- `apps/dashboard/src/server/ksei/schedule.ts`

Source: apinrdw/kumora#359, apinrdw/kumora#397
