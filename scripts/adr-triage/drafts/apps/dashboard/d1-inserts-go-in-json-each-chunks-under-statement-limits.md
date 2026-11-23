# D1 inserts go in json_each chunks under statement limits

D1 allows 100 bound parameters and 100 KB per statement. Rows therefore go in chunks of at most 1,000 rows and 90,000 bytes of JSON, each chunk one `INSERT … SELECT` over `json_each` of one bound JSON array: 1,000 rows of issuer names at their 256 characters, each written as `\u0001`, took 1.55 MB. A holdings month replace and a broker totals build both use these chunks (`monthRows`), and a build sends them in batches of a bounded number of statements, so a ~60,000-row day is 7 batches.

Sites:
- `apps/dashboard/src/server/holdings/month-replace.ts`
- `apps/dashboard/src/server/broker-totals/db.ts`

Source: apinrdw/kumora#355, apinrdw/kumora#419
