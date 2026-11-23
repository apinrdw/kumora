# A side alerts nothing until it holds 100 sweeps

A sweep alert sounds for the top 1% of a side's sweeps: the cutoff is the ⌈n/100⌉-th largest of its n earlier sweeps, as `sweepThreshold` (`lib/sweeps.ts`) takes the top N% at N = 1. With fewer than 100 sweeps that cutoff is the largest so far, so every new high would sound. A side therefore alerts nothing until it holds 100 sweeps.

Sites:
- `apps/dashboard/src/server/market-live/sweep-alerts.ts`

Source: apinrdw/kumora#501
