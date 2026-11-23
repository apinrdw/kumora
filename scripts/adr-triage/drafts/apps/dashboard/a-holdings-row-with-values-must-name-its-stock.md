# A holdings row with values must name its stock

A holdings row whose stock code wasn't read was skipped, and the month was replaced without it. So in the classification, investor-type and above-1% parses, a row holding any value (but `DATE`, errors and blanks) must name its stock by a text code (`SHARE CODE`, `STOCK_CODE`, `SHARE_CODE`), or the month fails.

Sites:
- `apps/dashboard/src/server/holdings/above-1.ts`
- `apps/dashboard/src/server/holdings/classification.ts`
- `apps/dashboard/src/server/holdings/investor-type.ts`
