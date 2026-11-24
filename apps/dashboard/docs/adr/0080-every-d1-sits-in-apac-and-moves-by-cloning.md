# Every D1 sits in apac and moves there by cloning the one it replaces

Production requests are served from Singapore. A D1 created without a location hint landed in western North America (AuthDb, HoldingsDb) or western Europe (BrokerTotalsDb), so each query that skips the session cookie cache paid about 0.4 s. Every stage's D1 therefore carries `primaryLocationHint: "apac"`, with no per-stage branch, so staging rehearses each production move.

A D1's location is fixed when it is created, so adding the hint replaces the database. Alchemy creates the new database, repoints the Worker and deletes the old one. On its own, that would lose every user, holding and broker total. Each move therefore also passes `clone` with the stage's previous database id, read from Alchemy's state row for the same logical id. Alchemy copies (exports and imports) the old database into the new one, and only when it is creating the new one, so later deploys ignore `clone`. A stage deploying for the first time has no state row and starts empty. Anything written between the export and the switch is lost, so the owner publishes each production Release outside IDX market hours.

We rejected these alternatives:
- Reading admin sessions through the cookie cache. A ban or a role change would then take up to 5 minutes to reach admin pages.
- Pinning the Worker near the databases. BrokerTotalsDb sits on another continent.
- A maintenance mode. It needs new code for a one-off cutover.
- Rebuilding HoldingsDb and BrokerTotalsDb from source. The stock pages would show gaps until the rebuild finished.

If a deploy fails partway through a clone, the new database exists but is incomplete, and the next deploy will not clone again. Delete the new database before retrying.

`clone` is removed once a database's production move is confirmed.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#658
