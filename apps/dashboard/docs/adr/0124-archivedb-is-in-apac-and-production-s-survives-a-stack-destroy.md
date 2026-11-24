# ArchiveDb is in apac, and only Production's survives a stack destroy

The archive admin pages are served from `SIN`, while the KSEI archive bucket sits in `WEUR` and HoldingsDb in `WNAM`, so each serial read crossed an ocean and the pages took 3 to 4 s (apinrdw/kumora#657). ArchiveDb, which holds what those pages read, is created with `primaryLocationHint: "apac"`. The hint can't change in place: Alchemy replaces a D1 whose hint changes and deletes the old one first, so moving it loses its rows. The report index rebuilds from R2, but the runs that move into it later do not. Production's ArchiveDb is retained (`RemovalPolicy.retain`) across a stack destroy, as Production's buckets survive one (ADR 0006); any other stage's is destroyed with its stack.

Sites:
- `apps/dashboard/alchemy.run.ts`

Source: apinrdw/kumora#659
