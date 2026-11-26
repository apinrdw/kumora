# Every flushed trade moves the sweep brokers build back

Once a day holds broker codes, a trade stored after a recompute can bring codes, join a sweep or split one. So every flushed trade, coded or not, moves the sweep brokers build back in its flush's transaction. A sweep never crosses a minute, so the day's next GET rebuilds from that trade's minute.

Sites:

- `apps/dashboard/src/server/market-live/sweep-brokers.ts`

Source: apinrdw/kumora#343, apinrdw/kumora#349
