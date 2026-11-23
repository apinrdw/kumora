# Holdings tables are WITHOUT ROWID on the full key

HoldingsDb's holdings tables, `classification_holding` and the KSEI table, are WITHOUT ROWID and keyed on their full key, so an insert writes one row and no index row.

Sites:
- `apps/dashboard/holdings-migrations/0001_classification.sql`
- `apps/dashboard/holdings-migrations/0002_ksei.sql`

Source: apinrdw/kumora#355
