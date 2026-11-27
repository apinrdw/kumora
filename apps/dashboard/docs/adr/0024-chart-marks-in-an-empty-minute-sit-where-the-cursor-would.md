# Chart marks in an empty minute sit where the cursor would

The candle chart and the footprint draw the same minutes (`lib/chart-nav.ts` `chartMinutes`), so a mark in a minute with no candle, such as a wall in a minute with no trade or an empty minute's Exhaustion, sits where the cursor line would (`lib/replay.ts` `cursorLogical`), not on added whitespace. The book heatmap places each minute the same way: at its candle's centre, each slice one `SLICES`th of the bar spacing further on, where the cursor line and a sweep bubble of that second sit (`lib/sweeps.ts` `bubbleOffset`).

Sites:

- `apps/dashboard/src/components/market-live/book-event-marks.ts`
- `apps/dashboard/src/components/market-live/order-flow-marks.ts`
- `apps/dashboard/src/components/market-live/book-heatmap.ts`

Source: apinrdw/kumora#279, apinrdw/kumora#526
