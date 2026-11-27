# Replacing a month's classification holdings in D1 from a Worker

Research for [#355](https://github.com/apinrdw/kumora/issues/355), part of the map [#350](https://github.com/apinrdw/kumora/issues/350). Written on 2026-11-15. The row shape comes from [#353](https://github.com/apinrdw/kumora/issues/353): one **classification holding** per (data date, stock code, classification, origin, shares), with zeros skipped. There is also one stock-month row per (data date, stock code), and a month keeps only the newest archived version.

Sources:

- Cloudflare docs, read 2026-11-15: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) (updated Oct 30, 2026), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) (Oct 30, 2026), [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) (Jun 22, 2026), [Query JSON](https://developers.cloudflare.com/d1/sql-api/query-json/), [Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/), [Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) (Aug 10, 2026), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) (Nov 13, 2026).
- Workflow step limits as recorded in [Cloudflare Workflows for a shareholding archive run](cloudflare-workflows-shareholding-archive.md).
- Vendored Alchemy, `repos/alchemy/packages/cloudflare/src/D1/`.
- **Local runs**: a throwaway Worker under Miniflare 4.20260730.0 (workerd 2026-07-30) with a local D1. Miniflare's D1 is SQLite inside a local Durable Object, not production D1. Every number marked _local_ comes from it. Nothing ran against a Cloudflare account.

## Answer

- **One `db.batch` per month is atomic, and 30K rows fit in one.** D1 says that batched statements "are SQL transactions": if one statement fails, D1 "aborts or rolls back the entire sequence". The statements run "sequentially, non-concurrently" ([D1 Database API, `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)). D1 documents no cap on statements or rows per batch. The binding limits are per statement and 30 seconds for the whole batch call ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), footnote 3). Locally, a batch that deletes the old month and inserts 30,960 rows takes 63–81 ms. Readers never saw a partial month, and a batch that failed on its last statement left the old month intact.
- **Recommended pattern.** Use one Workflow step per data date. The step sends one `batch`:
  1. `DELETE FROM classification_holding WHERE data_date = ?`
  2. `DELETE FROM stock_month WHERE data_date = ?`
  3. about 30 statements of the form `INSERT INTO classification_holding (…) SELECT value->>0, value->>1, … FROM json_each(?)`, each bound to one JSON array of 1,000 rows (about 45 KB)
  4. one such insert for the ~960 stock-month rows
  5. an upsert of the month's row with its sha256.

  The parameter cap is per statement, and this shape uses one parameter per statement. That keeps the batch near 33 statements, not 1,541 multi-row inserts or 30,962 single-row inserts. It was the fastest shape locally. A retry of the step reruns the same delete and insert, so the result is the same however many times it runs.

- **The version pointer is the fallback, not the default.** You would insert under a new version id across several batches or steps, then flip a per-date `version` in one statement, then delete the old version. This is atomic for readers too: locally, 397 reads during a 34-batch replace saw no partial month. Choose it only if a production month comes close to the 30 s batch limit or the database-wide 'execution limits' that the [FAQ](https://developers.cloudflare.com/d1/platform/limits/#query-performance) warns of for "hundreds of thousands of rows". It costs the same rows written. It adds a join to every read and a cleanup step.
- **Never write a month in several batches straight into the rows that readers query.** Locally, 194 of 214 reads during a 17-batch replace saw a partial month, and most of them saw an empty one.
- **Readers.** Read a month's holdings and stock-month rows in one statement or one `batch`. Two separate queries could fall on either side of a replace. Keep read replication off: Alchemy defaults it to `disabled` (`repos/alchemy/packages/cloudflare/src/D1/Database.ts`, `readReplication`). Replicas are "arbitrarily out of date" unless reads go through the Sessions API ([Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/#replica-lag-and-consistency-model)).
- **Indexes double the rows written.** D1 counts a second written row for each index that a write touches ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/#definitions), item 6). Make the holdings table `WITHOUT ROWID` with `PRIMARY KEY (data_date, stock_code, classification, origin)`. The key is then the table, and an insert writes one row. Locally, a rowid table with a separate unique index wrote 91,920 rows for a replace, against 61,920 for `WITHOUT ROWID`.
- **Cost: $0.** Workers Paid includes 50 million rows written a month, and the overage is $1.00 per million ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/#billing-metrics)). A replace writes about 62K rows (the delete plus the insert), and a first fill writes about 31K. A year of months, each parsed and then reparsed once, comes to under 1M rows written. The 8-month backfill (~133K holdings) comes to about 141K rows written. Both are well under 1% of a single month's included writes.

## Limits that bind

From [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) unless noted:

| Limit                         | Value                            | Effect here                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bound parameters per query    | 100                              | A 5-column multi-row `INSERT` holds at most 20 rows. One JSON parameter avoids the cap. _Local:_ 100 parameters ran, and 101 failed with `too many SQL variables`.                                                                                                                                                                                   |
| SQL statement length          | 100,000 bytes                    | Applies to each statement inside a batch ("Batch limits"). _Local:_ a 99,001-byte statement ran, and a 100,001-byte one failed with `SQLITE_TOOBIG`.                                                                                                                                                                                                 |
| String, `BLOB` or row size    | 2,000,000 bytes                  | Caps one JSON parameter. A 1,000-row chunk is about 45 KB. The whole 30K-row month is about 1.3 MB, which ran locally as one parameter, but leaves little room. _Local:_ a 2,000,001-byte string still bound, and a 3,000,000-byte one failed.                                                                                                       |
| SQL query duration            | 30 s                             | Footnote 3: "this duration limit also applies to the entire batch call".                                                                                                                                                                                                                                                                             |
| Queries per Worker invocation | 1,000 (Paid)                     | "a `db.batch()` call counts as a single query against it".                                                                                                                                                                                                                                                                                           |
| Large writes                  | —                                | "A single query that attempts to modify hundreds of thousands of rows … will exceed execution limits. Break the work into smaller chunks (e.g., processing 1,000 rows at a time)" ([limits FAQ](https://developers.cloudflare.com/d1/platform/limits/#query-performance)). A month is ~30K rows, and 1,000-row statements match the suggested chunk. |
| Concurrency                   | single-threaded                  | "Each individual D1 database is inherently single-threaded, and processes queries one at a time". Readers wait while the replace batch runs. Locally that wait is ~60–80 ms.                                                                                                                                                                         |
| Worker CPU                    | 30 s default, up to 5 min (Paid) | Waiting on D1 does not count ([Workers limits, CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)). A Workflow step has the same 30 s default and unlimited wall clock ([archive Workflow research](cloudflare-workflows-shareholding-archive.md)).                                                                      |
| Subrequests                   | 10,000 per invocation (Paid)     | A D1 call is a subrequest ([Workers limits, Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)). One batch per month uses one.                                                                                                                                                                                     |
| Memory                        | 128 MB per isolate               | 30K rows plus their JSON is a few MB.                                                                                                                                                                                                                                                                                                                |

There is no SQL `BEGIN`/`COMMIT` on D1. The import guide tells you to remove them from dumps, or D1 fails with "cannot start a transaction within a transaction" ([Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)). A batch is the only multi-statement transaction. Better Auth's D1 dialect notes the same thing ([Better Auth on Workers with D1](better-auth-workers-d1.md)).

**Retries.** "Write queries are not retried automatically" after `Network connection lost` ([Debug D1, error list](https://developers.cloudflare.com/d1/observability/debug-d1/#error-list)). After that error, the Worker cannot tell whether the batch committed. A delete-then-insert batch for a single date gives the same result either way, so a Workflow step retry is safe.

## Binding through Alchemy

`Cloudflare.D1.Database("ClassificationDb", { migrations })` on the dashboard `Website`, as `AuthDb` is bound in `apps/dashboard/alchemy.run.ts`. The Worker gets a plain `D1Database`. Alchemy's Effect wrapper `QueryDatabaseBinding` calls the binding's own `raw.batch(...)` (`repos/alchemy/packages/cloudflare/src/D1/QueryDatabaseBinding.ts`), so batch behavior is D1's own.

## Local runs

Harness: a Worker under Miniflare, and a Node driver that calls it through `dispatchFetch`. Each trial seeds generation 1 of a month: 30,000 synthetic holdings (960 stocks × 32 classification-origin pairs) and 960 stock-month rows. It then replaces the month with generation 2. During the replace, four reader loops poll `SELECT count(*), min(shares / 1e7), max(shares / 1e7) … WHERE data_date = ?`. Each holding's `shares` value encodes its generation, so a full old month, a full new month and a partial month are each easy to tell apart. Times are the Worker's own wall clock around the replace. `duration` is the sum of D1's `meta.duration`. There were 3 runs each.

| Pattern                                                   | Batches | Statements | Worker ms | D1 `duration` ms | rows_written | Partial reads                                               |
| --------------------------------------------------------- | ------- | ---------- | --------- | ---------------- | ------------ | ----------------------------------------------------------- |
| One `INSERT` per row, one batch                           | 1       | 30,962     | 569–574   | 280–297          | 61,920       | 0                                                           |
| Multi-row `INSERT`, 20 rows (100 params), one batch       | 1       | 1,541      | 154–157   | 73–80            | 61,920       | 0                                                           |
| `json_each`, 1,000 rows per statement, one batch          | 1       | 33         | 72–78     | 57               | 61,920       | 0                                                           |
| `json_each`, the whole month in one statement, one batch  | 1       | 4          | 63–66     | 48–49            | 61,920       | 0                                                           |
| Same as the 1,000-row case, rowid table plus unique index | 1       | 33         | 98–102    | 68               | **91,920**   | 0                                                           |
| Multi-row into the live rows, 100 statements per batch    | 17      | 1,541      | 178–180   | 82–88            | 61,920       | 0 without pauses, **194 of 214** with 20 ms between batches |
| Version id plus pointer flip, `json_each` 1,000           | 10      | 36         | 74–76     | 53–55            | 61,921       | 0, and 0 of 397 with 34 batches and 20 ms pauses            |

Notes on the runs:

- **rows_written.** The count is the delete plus the insert: 30,960 + 30,960. In the rowid case, each insert also writes an index row: 30,960 + 30,960 × 2 = 91,920, which matches D1's billing rule. This is the local simulator's count. Whether production counts `WITHOUT ROWID` the same way is not verified here. Check `meta.rows_written` on the first production run.
- **rows_read.** The `json_each` inserts also count their source rows as read (61,920 against 30,960 for multi-row). Reads cost $0.001 per million past 25 billion a month, so this does not matter.
- **Single batches block readers.** In the single-batch runs, reads issued during the replace waited and then returned the new month. In the 17-batch run without pauses, readers happened not to land between batches. With 20 ms between batches, which stands in for separate Workflow steps, most reads saw a partial or empty month.
- **Failure rolls back.** One batch had a delete, 30 `json_each` inserts of a new generation, and a final insert that broke the primary key. It failed with `UNIQUE constraint failed … SQLITE_CONSTRAINT_PRIMARYKEY`. A read afterwards returned the old month, with all 30,000 rows and generation 1.

**Not measured:** production D1 timings. Production writes are "durably persisted across several locations" ([limits FAQ](https://developers.cloudflare.com/d1/platform/limits/#query-performance)), so expect them to be slower than local. The ticket asked for a run on a real D1 with the Oct 2026 report. That needs a cloud D1, which this research did not create. Before trusting the single-batch shape, run the replace once on Production's ClassificationDb, which has to be created for the feature anyway, and log `meta.duration` and `rows_written` per statement. Switch to the version pointer if the batch takes more than a few seconds.

## Sketch

```sql
CREATE TABLE classification_holding (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  classification TEXT NOT NULL,
  origin TEXT NOT NULL,
  shares INTEGER NOT NULL,
  PRIMARY KEY (data_date, stock_code, classification, origin)
) WITHOUT ROWID;
```

```ts
const insertHoldings = (rows: ReadonlyArray<readonly [string, string, string, string, number]>) =>
  chunk(rows, 1000).map((part) =>
    db
      .prepare(
        "INSERT INTO classification_holding (data_date, stock_code, classification, origin, shares) " +
          "SELECT value->>0, value->>1, value->>2, value->>3, value->>4 FROM json_each(?)",
      )
      .bind(JSON.stringify(part)),
  )

await db.batch([
  db.prepare("DELETE FROM classification_holding WHERE data_date = ?").bind(dataDate),
  db.prepare("DELETE FROM stock_month WHERE data_date = ?").bind(dataDate),
  ...insertHoldings(holdings),
  ...insertStockMonths(stockMonths),
  db
    .prepare("INSERT INTO classification_month (data_date, sha256) VALUES (?, ?) ON CONFLICT (data_date) DO UPDATE SET sha256 = excluded.sha256")
    .bind(dataDate, sha256),
])
```

`->>` and `json_each` are documented D1 SQL ([Query JSON](https://developers.cloudflare.com/d1/sql-api/query-json/)). `->>` returns an SQL value, so a JSON integer lands as `INTEGER`. The largest share count, 1.14 × 10¹², is a safe integer in both JSON and SQLite.
