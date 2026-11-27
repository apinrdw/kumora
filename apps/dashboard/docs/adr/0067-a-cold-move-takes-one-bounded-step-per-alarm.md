# A cold move takes one bounded step per alarm

Moving a day to R2 takes one bounded step per alarm, well under the alarm's 30 s of CPU: 250 codes' views (1,000 answers), 50 tape segments (500,000 trades) or 20 codes' books. The busy day moves in 9 runs of about 1.5 s each, reading 385 K rows and writing 19 (`row-budgets.workerd.test.ts`).

Sites:

- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#556
