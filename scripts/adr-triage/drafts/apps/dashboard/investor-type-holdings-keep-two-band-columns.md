# Investor-type holdings keep two band columns

The investor-type holdings table keeps the two bands as two columns, not as a band key, because the stock page always reads both bands together: about 15k rows a month instead of 25k. Like `classification_holding`, it is WITHOUT ROWID and keyed on its full key.

Sites:
- `apps/dashboard/holdings-migrations/0005_investor_type.sql`

Source: apinrdw/kumora#396
