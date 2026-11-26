# Heatmaps are worked out on read from book chunks

A day stores no heatmap rows. A heatmap GET reads the code's book chunks, about 273 rows, and runs the chunk close's own math on them (`chunkSlices` in `heat-rows.ts`), working out each stretch's slices with the page's own weighting (`heatSlices`); a minute with no frame stores no row. A sealed day of 209 stretches answered in 59 ms, one with none in 56 ms (median of 7, Node 26, 2 cores, measured 2026-11-14). A day recorded before this change holds a heatmap row beside each chunk up to the change, and answers from those.

Sites:

- `apps/dashboard/src/server/market-live/day-store.ts`
- `apps/dashboard/src/server/market-live/heat-rows.ts`

Source: apinrdw/kumora#279, apinrdw/kumora#555
