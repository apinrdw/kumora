# Schema changes are forward migrations

A change to a D1 schema is a new forward migration, never an edit of one already applied: Alchemy refuses edited applied migrations, and a Preview may have applied the old one already. A day built before a new column reads its default, 0, until the reconcile rebuilds it at a bumped build version.

Sites:
- `apps/dashboard/broker-totals-migrations/0002_candle_trades.sql`
- `apps/dashboard/broker-totals-migrations/0003_built_day_missing_trades.sql`
- `apps/dashboard/broker-totals-migrations/0004_totals_freq.sql`

Source: none
