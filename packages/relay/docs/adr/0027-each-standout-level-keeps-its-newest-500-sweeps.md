# Each standout level keeps its newest 500 sweeps

The trading-day object keeps the day's standout sweeps as its snapshot backlog, and the live page keeps them as its All codes rows. Both keep, for each level, the newest 500 standout sweeps at or under it (`keptStandouts` and `STANDOUTS_PER_LEVEL` in `packages/relay/src/standout-sweeps.ts`), not the newest 500 overall. The All codes tab lists the newest 500 of them at the level picked (`shownStandouts`), and the kept list is every row some level lists, so the cap and the level filter live in one function. At 10% a busy day across ~900 codes can decide tens of thousands of standout sweeps, so a list capped as a whole would push the rarer 1% rows out. A list kept this way holds at most 3 × 500 rows of ~90 bytes each when encoded, so a snapshot carries at most ~135 KB of them, and a page left open all day keeps bounded memory. The page drops its oldest rows as new ones arrive, and a reload refills it from the snapshot's backlog. The object and the page keep the same cap, so a reconnect neither loses rows that the page could show nor adds rows that the page would drop.

Sites:
- `packages/relay/src/standout-sweeps.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`
- `apps/dashboard/src/components/market-live/standout-store.ts`

Source: apinrdw/kumora#704, apinrdw/kumora#705
