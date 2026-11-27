# Crons that read outside sources run on Production only

Alchemy's dev runtime fires a Worker's crons, so an ungated cron would make `vp run dev` and every Preview call IDX, KSEI or Stockbit. Each cron that reads an outside source is therefore set by stage, on Production only, the way Google sign-in is bound: the IDX archive, the KSEI archive and parse, the shareholding parse, the sector cron, the logo sync, the Special Monitoring Board cron and the disclosure cron, which fires every 15 minutes. Other stages start a run with Run now, so their tables, such as `stock_sector` and `special_board`, stay empty until someone does.

The broker totals reconcile is the deliberate exception and runs on every stage: it touches only the stage's own day index, BrokerTotalsDb and trading days, and the extension's extra target feeds a second stage, so a dev or Preview run calls nothing outside.

Sites:

- `apps/dashboard/src/server/stage-crons.ts`

Source: apinrdw/kumora#308, apinrdw/kumora#326, apinrdw/kumora#359, apinrdw/kumora#397, apinrdw/kumora#427, apinrdw/kumora#432, apinrdw/kumora#437, apinrdw/kumora#521, apinrdw/kumora#717
