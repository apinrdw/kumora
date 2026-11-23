# Cold events are stored only for codes with one

A cold day stores BookEvents and OrderFlowEvents only for a code that has an event. Every other code's answer is built from whether the day recorded those events, stored once as `noEvents`. A day moved before this change answers BookEvents with 404 and OrderFlowEvents as not recorded.

Sites:
- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#633
