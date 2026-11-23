# A broker codes status lists at most 1,000 missing ranges

A broker codes status lists at most 1,000 missing ranges, the first after the GET's `after`, and counts every missing trade in `missingCount`; a walk pages on with `after`. A 1.5 M-trade day missing every other trade has 750,000 ranges, which as one list exhausted a Worker's 128 MiB. A cold day's stored status keeps only the first `MISSING_RANGES` ranges, so past them it lists none: a cold day takes no batch, so its missing ranges only say what will stay missing.

Sites:
- `packages/relay/src/broker-codes.ts`
- `apps/dashboard/src/server/market-live/cold-days.ts`

Source: apinrdw/kumora#556
