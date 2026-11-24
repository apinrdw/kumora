# Each data set gets its own D1 with read replication off

HoldingsDb, BrokerTotalsDb and ArchiveDb are each a D1 database of their own, apart from AuthDb and from each other, with their own migrations, so one can be reset or rebuilt alone. Read replication stays off, Alchemy's default, because a replica could serve a month mid-replace or a day mid-write. `apps/e2e/reset-test-stage.ts` reads HoldingsDb's state file by its id.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#353, apinrdw/kumora#419, apinrdw/kumora#659
