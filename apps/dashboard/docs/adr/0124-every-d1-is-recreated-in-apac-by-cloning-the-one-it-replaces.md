# Every D1 is recreated in apac by cloning the one it replaces

Production requests are served from Singapore. A D1 created without a location hint landed in western North America (AuthDb, HoldingsDb) or western Europe (BrokerTotalsDb), so each query that skips the session cookie cache paid about 0.4 s. Each D1 therefore carries `primaryLocationHint: "apac"` on every stage, with no per-stage branch, so staging rehearses each production cutover. The databases are recreated one at a time, AuthDb first because its data cannot be rebuilt. HoldingsDb and BrokerTotalsDb follow in their own changes, once each one's export is known to fit D1's import limits. HoldingsDb moved second: on 2026-11-24, production's measured 104 MB with no virtual table and integers below 2^42, well inside the 5 GB import, the 100 KB statement and the 52-bit export precision limits. BrokerTotalsDb moved last: on 2026-11-25, production's measured 115 MB in 4 tables (about 1.05 million rows) with no virtual table, integers below 2^43, and REAL columns that hold only whole numbers below 10^9, well inside the same three limits. ArchiveDb (apinrdw/kumora#659) is declared the same way, so each stage creates it in apac on its first deploy, with nothing to clone.

A D1's location is fixed when it is created, so adding the hint replaces the database. Alchemy creates the new database, repoints the Worker and deletes the old one. On its own, that would lose every account, parsed holding and broker total. Each recreation therefore also passes `clone` with the stage's previous database id, read from Alchemy's state row for the same logical id. Alchemy copies (exports and imports) the old database into the new one, and only when it is creating the new one, so later deploys ignore `clone`. A stage deploying for the first time has no state row and starts empty. A state row that names no database stops the deploy, rather than replacing the database without copying it.

During the cutover, the old database refuses queries while D1 exports it, and anything written between the export and the switch is lost. The owner therefore publishes each production Release outside IDX market hours.

We rejected these alternatives:
- Reading admin sessions through the cookie cache. A ban or a role change would then take up to 5 minutes to reach admin pages.
- Pinning the Worker near the databases. BrokerTotalsDb sat on another continent.
- A maintenance mode. It needs new code for a one-off cutover.
- Rebuilding HoldingsDb and BrokerTotalsDb from source. The stock pages would show gaps until the rebuild finished.

If a deploy fails partway through a clone, the new database exists but is incomplete, and the next deploy will not clone again. Delete the new database before retrying.

`clone` came out once every production cutover had landed: AuthDb and HoldingsDb on 2026-11-24, BrokerTotalsDb on 2026-11-25, each reported in APAC (Tokyo) by the D1 API. Left in, it would copy again on any later replace, from a source that may be gone. The declarations now carry only the hint, so a later change that replaces a database copies nothing and loses its data unless that change brings back a clone of its own.

The move took admin pages' fresh session read (`authorize`) from a p50 of about 390 ms to about 180 ms from Singapore, measured on 2026-11-25. That is short of the hoped-for well under 100 ms: `apac` placed the primaries in Tokyo, not Singapore, and the hint can be no finer.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#658
