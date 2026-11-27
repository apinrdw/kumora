# A day takes broker codes until its cold move starts

A day's broker codes, and the order numbers the walks send after them, keep arriving after the close, and a rebuild can hold a day's move past midnight. So the day's own state, not the calendar, ends what it takes: the trading-day object takes broker codes until the first step of its move runs and none after, and a move starts at midnight after its day at the earliest, as the object serves the live day's viewers until then. That keeps a cold day's stored answers equal to what it held. A recorded answer says whether the day still takes codes (`takesCodes`), and the page treats an answer as final once it says the day takes no more, or doesn't say; order numbers never make a day complete. The field is optional and read as false when absent, since only a move stored an answer without it, and a cold day's answer is kept for good.

Sites:

- `packages/client/src/recorded-day.ts`
- `packages/relay/src/recorded-day.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#556, apinrdw/kumora#632
