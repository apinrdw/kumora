# A side alerts nothing until it holds 100 sweeps

A sweep stands out at the top 1%, 5% or 10% of its side's sweeps, and a sweep alert sounds for one at 1%. Each cutoff is taken over the side's earlier sweeps by `levelOf` in `sweep-alerts.ts`. With fewer than 100 sweeps the 1% cutoff is the largest so far, so every new high would sound. A side therefore lists and alerts nothing, at any of the three levels, until it holds 100 sweeps. One warm-up serves all three, so a code enters the All codes list at every level at once.

Sites:
- `apps/dashboard/src/server/market-live/sweep-alerts.ts`

Source: apinrdw/kumora#501, apinrdw/kumora#705
