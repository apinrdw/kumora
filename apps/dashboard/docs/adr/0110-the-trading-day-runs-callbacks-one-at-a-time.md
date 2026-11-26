# The trading day runs callbacks one at a time

Every guard on the trading day's state reads what its write then changes, and the run loop yields mid-callback, so overlapping callbacks would write over each other. The object's callbacks and timer bodies therefore run one at a time under one permit. The permit is taken where a callback or timer body enters, or again after the body gave it back (ADR-0123), and never while it is held, so nothing under it waits on it.

Sites:

- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#159, apinrdw/kumora#603
