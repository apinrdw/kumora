# Busy-day figures follow fixed steps of the trade number

The row budgets' busy day needs synthetic broker figures that the TypeScript fixtures and the SQL that writes the broker trades index agree on. Trade n's buyer is `BROKERS[(n * BUYER_STEP) % BROKERS.length]`, its seller the same with `SELLER_STEP`, and a side's investor type is F when its number (n for the buyer, n + 1 for the seller) is a multiple of `FOREIGN_EVERY`. `busy-day.ts` writes the broker trades index in SQL with these same figures, so changing one rule means changing both.

Sites:
- `apps/dashboard/billing/busy-figures.ts`

Source: none
