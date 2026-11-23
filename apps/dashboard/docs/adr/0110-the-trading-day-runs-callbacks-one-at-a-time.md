# The trading day runs callbacks one at a time

Every guard on the trading day's state reads what its write then changes, and the run loop yields mid-callback, so overlapping callbacks would write over each other. The object's callbacks and timer bodies therefore run one at a time under one permit. The permit is taken only where a callback or timer body enters and never inside, so nothing under it waits on it.

Sites:
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#159
