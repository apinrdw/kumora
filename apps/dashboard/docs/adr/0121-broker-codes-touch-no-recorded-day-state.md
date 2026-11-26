# Broker codes touch no recorded day state

Broker codes arrive after a day's trades, and a recorded day's answers must stay byte-identical. On a day the relay recorded, and on any sealed day, broker codes touch no recorded day state: no flush, seal or index row. A walk day before its seal takes their fields as its tape (`walkTapeOf`), and the batch that makes it buildable arms its seal (`walkSealDue`).

Sites:

- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#244, apinrdw/kumora#437
