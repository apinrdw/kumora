# Days before #561 drop their broker trades index

Days recorded before apinrdw/kumora#561 hold a broker trades index that nothing reads. Such a day drops that index and the facts of its rebuild. In workerd the drop of a busy day's 2.92 M rows read 14 rows and wrote none (`row-budgets.workerd.test.ts`).

Sites:

- `apps/dashboard/src/server/market-live/broker-codes.ts`

Source: apinrdw/kumora#561
