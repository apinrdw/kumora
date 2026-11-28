---
Status: superseded by ADR-0026
---

# Done Details rows go to trades only as one run

Ajaib's Done Details rows carry no trade number, so the walk matches them to the kept tape trades by a key: every field both sources report. A key gives its rows, in aggressor order, to its kept trades only when there are as many rows as trades and the trades form one run (`oneRun`). A code with a row the walk can't read, which could belong to any trade, gets nothing. Every other key is left to Stockbit's walk, which has trade numbers.

Sites:

- `apps/extension/src/worker/broker-codes/done-details-walk.ts`

Source: apinrdw/kumora#622, apinrdw/kumora#632
