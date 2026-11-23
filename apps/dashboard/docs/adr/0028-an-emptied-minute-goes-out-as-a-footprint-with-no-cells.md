# An emptied minute goes out as a footprint with no cells

A minute whose last regular-board trade left it goes out as a footprint with no cells, for any code, and with no candle, as its sweeps go out empty. The pages drop that minute (`candle-store.ts`, and Market Bubbles' `lib/bubbles.ts`), so the protocol needs no removal message. The candle store drops that minute's footprint, and its candle unless the same delta carries one, and reports it as Dropped, because a chart can't take one bar back.

Sites:
- `apps/dashboard/src/server/market-live/candles.ts`
- `apps/dashboard/src/components/market-live/candle-store.ts`

Source: apinrdw/kumora#279, apinrdw/kumora#436
