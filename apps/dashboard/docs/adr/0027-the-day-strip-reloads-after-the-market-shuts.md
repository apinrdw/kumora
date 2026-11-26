# The day strip reloads after the market shuts

The day strip is loaded on mount, and again past the copy the browser keeps until 17:01 WIB (`day-index.ts`): a minute after the loader first says the market shut on a day, so the 17:00 seal has written the day's row. A row its retry lands later shows on the next load. Midnight and 08:40 change the loader's answer, not the days recorded.

Sites:

- `apps/dashboard/src/components/market-live/day-strip.tsx`

Source: apinrdw/kumora#157
