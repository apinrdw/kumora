# How Cloudflare counts Durable Object SQL rows and storage, and where to read them by stage and day

Research for [#530](https://github.com/apinrdw/kumora/issues/530), map [#529](https://github.com/apinrdw/kumora/issues/529). Written 2026-11-18. Every source below was read on 2026-11-18.

## Short answer

- **Rows read count the rows SQLite's VM steps over, not the rows returned.** A full scan, an unindexed `WHERE`, `max()` of an unindexed column and `count(*)` each read every row in the table. A sort, `GROUP BY`, `DISTINCT` or window function that needs a temporary b-tree reads the table again from that b-tree: 2× for `ORDER BY`/`GROUP BY` on an unindexed column, 3–4× for a window function. A primary-key lookup reads 1 row. `min()`/`max()` of the primary key, or `max(minute)` under a `(code, minute)` prefix, reads 1 row. A range scan reads its rows plus 1.
- **Rows written count each b-tree entry inserted or row deleted, not each index entry removed.** `INSERT OR REPLACE` of an existing `WITHOUT ROWID` row writes **1** row, the same as a new row. `INSERT OR IGNORE` of an existing row writes **0** rows, but a rowid table's insert still reads 1 row for its key check. Each secondary index that the write touches adds 1 write. `CREATE TABLE IF NOT EXISTS` on an existing table and a `transactionSync()` both count 0.
- **`cursor.rowsRead` / `cursor.rowsWritten` are the billed figures** for every `sql.exec()` statement: the docs say so, and the workerd source feeds the same counters to the billing observer. The bill also has rows that no cursor shows: each `setAlarm()` and each KV-API call (`get`, `put`, `delete`, `list`). So the adapter's sums are a lower bound on the bill.
- **Stored data** is the SQLite database size. SQLite storage billing started on **2026-01-07** (target date, "no earlier"). Cloudflare defines GB-month for R2 as the average of each day's **peak** storage over the billing period. The Durable Objects pages do not define it, so the same definition for Durable Objects is unconfirmed. Under that definition, a bill that shows 7.26 GB and no charge yet fits a month-to-date average under 5 GB-month, or a charge that is only computed at the end of the period. Both readings are unconfirmed.
- **Data sources:** `durableObjectsPeriodicGroups` (sum `rowsRead`, `rowsWritten`, by `date`, `namespaceId`, `objectId`) and `durableObjectsSqlStorageGroups` (max `storedBytes`, by `date`, `namespaceId`). Neither dataset has a `scriptName` dimension, so map `namespaceId` to the script `kumora-dashboard-<stage>` through the REST namespaces list. GraphQL needs **Account → Account Analytics → Read**. The namespaces list needs **Workers Scripts Read**, or any other permission that its API page lists. Storage is per namespace only. For storage per object, use `storage.sql.databaseSize`, which the adapter already reports.

## How the counters work (workerd source)

Cloudflare's runtime counts rows with a patch to SQLite's VM, [`patches/sqlite/0001-row-counts-plain.patch`](https://github.com/cloudflare/workerd/blob/main/patches/sqlite/0001-row-counts-plain.patch) (workerd `main` at `bb08e38`, last change to the patch `8cd68e7` on 2026-11-05). It adds two statement counters, `LIBSQL_STMTSTATUS_ROWS_READ` and `LIBSQL_STMTSTATUS_ROWS_WRITTEN`, which are documented as "the number of rows read when executing this statement" and "the number of rows written". The patch increments them in these VM opcodes. The hunk contexts are in `src/vdbe.c`.

| Opcode (hunk context) | Counter | Effect |
| --- | --- | --- |
| `OP_Count` (`sqlite3BtreeCount(db, pCrsr, &nEntry)`) | read `+= nEntry` | `count(*)` bills every row in the b-tree. The estimate branch (`p3`) adds nothing. |
| `OP_SeekGE/GT/LE/LT`, `OP_SeekRowid`/`OP_NotExists`, `OP_Last`, `OP_Rewind` | read `+1` | each seek or positioning of a cursor |
| `OP_Next`/`OP_Prev` | read `+1` | each step to the next row, **including steps over an ephemeral (temporary) b-tree**: the read counters have no `isEphemeral` check |
| `OP_VNext` | read `+1` | virtual tables |
| `OP_Insert` | write `+1` if `!pC->isEphemeral` | rowid table row |
| `OP_IdxInsert` | write `+1` if `!pC->isEphemeral` | an index entry, **or a `WITHOUT ROWID` row** (a `WITHOUT ROWID` table is an index b-tree) |
| `OP_Delete` with `OPFLAG_NCHANGE` | write `+1` | a deleted row |
| `OP_Clear` | write `+= nChange` | `DELETE FROM t` with no `WHERE` |
| `OP_VUpdate` | write `+1` | virtual tables |

`OP_IdxDelete` is not patched, so removing an index entry costs nothing.

[`src/workerd/util/sqlite.c++`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c++) reads both counters with `sqlite3_stmt_status(statement, LIBSQL_STMTSTATUS_ROWS_READ, 0)` (`getRowsRead()`/`getRowsWritten()`) after each `sqlite3_step`. When the query is destroyed, it calls `db.sqliteObserver.addQueryStats(rowsRead, rowsWritten)` if `regulator->shouldAddQueryStats()`. [`src/workerd/util/sqlite.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.h) says that this flag "determines whether this query is billed", and: "We don't bill for TRUSTED queries since they are used internally by the system". [`sqlite-kv.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite-kv.h) says: "We bill for KV operations as rows read/written". The user `sql.exec()` regulator in [`src/workerd/api/sql.h`](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/sql.h) overrides `shouldAddQueryStats()`. So the counter that the cursor exposes is the counter that the billing observer receives.

The workerd [README](https://github.com/cloudflare/workerd) says it is "based on the same code that powers Cloudflare Workers". That production applies this same patch is an inference from that statement, plus the docs line quoted below.

## Measured: one statement at a time (local workerd)

I ran the installed `workerd` 1.20261026.1 (`workerd 2026-10-26`) with one SQLite-backed Durable Object (`enableSql = true`, `localDisk` storage). The setup used the shapes of `day-store.ts`: `trades` (`number INTEGER PRIMARY KEY` plus 3 columns, no index), `candles` (`PRIMARY KEY (code, minute) WITHOUT ROWID`), `facts` (`key TEXT PRIMARY KEY WITHOUT ROWID`), and `ix` (a rowid table with 2 secondary indexes, for comparison). It loaded 1,000 trades over 10 codes and 1,000 candles. Each figure is the statement cursor's `rowsRead` / `rowsWritten` after `toArray()`, which is what `durable-sql.ts` sums. The harness is at the end of this file.

### Writes

| Statement | Read | Written |
| --- | --- | --- |
| `CREATE TABLE IF NOT EXISTS` (new table) | 1 | 2 |
| `CREATE TABLE IF NOT EXISTS` (table exists) | **0** | **0** |
| `CREATE INDEX IF NOT EXISTS` (new, empty table) | 2 | 1 |
| `INSERT` new trade (rowid, no index) | 1 | 1 |
| 1,000 such inserts, summed | 1,000 | 1,000 |
| `INSERT OR IGNORE` trade, row exists | 1 | **0** |
| `INSERT OR IGNORE` trade, new row | 1 | 1 |
| `INSERT OR REPLACE` trade (rowid, no index), row exists | 1 | 1 |
| `INSERT` new candle (`WITHOUT ROWID`) | 0 | 1 |
| `INSERT OR REPLACE` candle (`WITHOUT ROWID`), row exists | 0 | **1** |
| `INSERT OR REPLACE` candle, new row | 0 | 1 |
| `INSERT OR REPLACE` fact, new / exists | 0 / 0 | 1 / 1 |
| `INSERT … ON CONFLICT DO UPDATE` candle, exists | 0 | 1 |
| `UPDATE` candle by full primary key | 1 | 1 |
| `INSERT` into `ix` (2 indexes) | 1 | **3** |
| `UPDATE ix` non-indexed column | 1 | 1 |
| `UPDATE ix` one indexed column | 1 | 2 |
| `INSERT OR REPLACE` into `ix`, row exists (2 indexes) | 1 | 3 |
| `DELETE` from `ix` by primary key (2 indexes) | 1 | **1** (index deletes are free) |
| `DELETE` trade by primary key | 1 | 1 |
| `transactionSync(() => SELECT 1)` | 0 | 0 |

### Reads (`trades` has 1,001 rows at this point)

| Statement | Returned | Read |
| --- | --- | --- |
| `SELECT * FROM trades` | 1,001 | 1,001 |
| `… WHERE price = 500` (unindexed, 1 match) | 1 | **1,001** |
| `… LIMIT 10` | 10 | 10 |
| `… WHERE number = 500` (rowid primary key) | 1 | 1 |
| `candles WHERE code = ? AND minute = ?` (`WITHOUT ROWID` primary key) | 1 | 1 |
| `candles WHERE code = 'C1'` (primary-key prefix) | 100 | 101 |
| `trades WHERE number BETWEEN 100 AND 199` | 100 | 101 |
| `ix WHERE a = 500` (secondary index, then table) | 1 | 2 |
| `SELECT count(*) FROM trades` | 1 | **1,001** |
| `SELECT count(*) FROM candles` (`WITHOUT ROWID`) | 1 | 1,002 |
| `count(*) WHERE number < 100` | 1 | 99 |
| `count(*) WHERE price < 100` (unindexed) | 1 | 1,001 |
| `max(number)` / `min(number)` (primary key) | 1 | **1** / 1 |
| `max(price)` (unindexed) | 1 | 1,001 |
| `max(minute) FROM candles WHERE code = 'C1'` | 1 | 1 |
| `ORDER BY number DESC LIMIT 1` | 1 | 1 |
| `ORDER BY price DESC LIMIT 1` (unindexed) | 1 | **2,002** |
| `GROUP BY code` (unindexed, 11 groups) | 11 | **2,002** |
| `candles GROUP BY code` (primary-key prefix) | 12 | 1,002 |
| `sum(price) OVER (ORDER BY number)` | 1,001 | **3,004** |
| `row_number() OVER (PARTITION BY code ORDER BY number)` | 1,001 | **4,016** |
| `WHERE number IN (SELECT number … WHERE number < 11)` | 9 | 28 |
| `WHERE number = (SELECT max(number) FROM trades)` | 1 | 2 |
| `SELECT DISTINCT code` | 11 | 1,001 |
| `trades JOIN candles` on candles' primary key, `number < 50` | 47 | 96 |
| `SELECT 1` | 1 | 0 |

The doubled reads match the patch. A sort or a grouping on a non-key column fills a temporary b-tree. Rows read count the scan of the table and then the `OP_Next` steps over the temporary b-tree. Rows written skip ephemeral cursors, so the temporary b-tree adds no writes.

## Answers, bullet by bullet

### Rows read

- **Full table scan: every row visited.** Confirmed by the docs and by measurement. The D1 pricing page applies to Durable Objects too: "Rows read and rows written included limits and rates match D1 pricing" ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). D1 says that rows read "measure how many rows a query reads (scans), regardless of the size of each row": "a table with 5000 rows and run a `SELECT * FROM table` as a full table scan … would count as 5,000 rows read". It adds: "A query that filters on an unindexed column may return fewer rows to your Worker, but is still required to read (scan) more rows" ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).
- **`count(*)`: every row in the table** (1,001 of 1,001), through `OP_Count`'s `nEntry`. With a `WHERE` on the key range, it reads only that range.
- **`GROUP BY`, `DISTINCT`, window functions, subqueries:** each reads the rows it visits. A temporary b-tree for a sort or grouping is read a second time, so the read is 2× the table. A window function reads 3–4× the table. A grouping on a primary-key prefix reads the table once. A subquery adds its own reads: `IN (…)` read 28 rows to return 9.
- **`min()`/`max()` of the primary key: 1 row.** `max()` of an unindexed column reads every row.
- **Primary-key lookup: 1 row**, for a rowid table and for a `WITHOUT ROWID` table. A lookup through a secondary index reads 2 rows (the index, then the table). A range or a prefix scan reads its rows plus 1, for the step that ends it.

### Rows written

- **`INSERT OR REPLACE` of an existing `WITHOUT ROWID` row: 1 row.** It also reads 0 rows. This was measured, not documented. The runbook's worry, "If a replaced row bills as two row writes", does not hold for these tables. On a rowid table with indexes, a replace bills 1 write for the row plus 1 for each index.
- **`INSERT OR IGNORE` of an existing row: 0 rows written.** On the rowid `trades` table, every insert, kept or ignored, also reads **1 row** for the key check (`OP_NotExists`).
- **Each index adds a write:** "every row update of an index counts as an additional row" ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). D1 says: "Indexes will add an additional written row when writes include the indexed column" ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). Measured: an insert into a table with 2 indexes writes 3 rows. An `UPDATE` of a non-indexed column writes 1. A `DELETE` writes 1 whatever the indexes, because `OP_IdxDelete` is not counted. The pricing page says "Deletes are counted as rows written."
- **`CREATE TABLE IF NOT EXISTS` at each wake: 0** when the table exists. Creating a table writes 2 rows and reads 1 (its `sqlite_schema` row), once. **A transaction adds 0.** `transactionSync` runs trusted internal statements, which are not billed. The measured `transactionSync` added 0.
- Not in the cursor, but billed: "Each setAlarm() is billed as a single row written", and "Key-value methods like get(), put(), delete(), or list() … are billed as rows read and rows written" ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

### Do the cursor counts match the bill?

**Yes for each SQL statement.** The docs describe `rowsRead` as "The number of rows read so far as part of this SQL query. This may increase as you iterate the cursor." and say "The final value is used for SQL billing". The same is said of `rowsWritten` ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). The workerd source passes the same counters to `addQueryStats` (see above). `durable-sql.ts` calls `toArray()` before it reads the counters, so it reads final values. Its sums fall short of the bill only by:

- statements that do not go through `durableSql`'s `exec`;
- `setAlarm()` calls and KV-API calls (not cursors);
- statements that throw after part of the work, if the adapter never reaches `rowsRead +=`.

**Unconfirmed:** whether the billed total for a stage-day equals the logged `billedRowsWritten` and billed reads. To confirm it, sum the Workers Logs `Rows written` lines for one Staging day (as in `docs/runbooks/order-flow-cost.md`) and compare them with the GraphQL query below for that day and the Staging namespace.

### Stored data

- **What is measured:** the SQLite database. The docs give no formula. `databaseSize` is "The current SQLite database size in bytes" ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). The pricing FAQ adds: "An empty SQLite database consumes approximately 12 KB of storage". It also says writes store "nominal amounts of metadata in internal tables … which counts towards your billable storage", which stays "until you call deleteAll()" ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). workerd's observer has `setSqliteStoredBytes(uint64_t sqliteStoredBytes)` (`sqlite.h`). That storage is reported as a byte count beside the row counts is an inference from that name.
- **Price:** "5 GB-month, + $0.20/ GB-month" on Workers Paid. "Durable Objects will be billed for stored data until the data is removed" ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **From when:** "Storage billing for SQLite-backed Durable Objects will be enabled in January 2026, with a target date of January 7, 2026 (no earlier)". "Only SQLite storage usage on and after the billing target date will incur charges" ([changelog, 2025-12-12](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/); [release notes, 2026-01-07 entry](https://developers.cloudflare.com/durable-objects/release-notes/)). No page confirms that the switch happened on that date. The pricing pages still say "will be enabled". Because the bill lists 7.26 GB stored, storage is at least metered now.
- **GB-month: unconfirmed for Durable Objects.** R2 defines it: "A GB-month is calculated by averaging the *peak* storage per day over a billing period (30 days)" ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). The Durable Objects and Workers pricing pages do not define it, nor whether a GB is 10⁹ or 2³⁰ bytes. Two readings fit "7.26 GB, no charge yet". In the first, 7.26 GB is today's size and the month-to-date average of daily peaks is still under 5 GB-month. In the second, the overage of (average − 5) × $0.20 is computed when the period closes. To tell them apart, take `max.storedBytes` per day from `durableObjectsSqlStorageGroups` for the billing period, summed over namespaces, and average it. Compare the result with 7.26 and with the next invoice.

### Data sources

| Source | Gives | Split by | Permission |
| --- | --- | --- | --- |
| GraphQL `durableObjectsPeriodicGroups` | `sum.rowsRead`, `sum.rowsWritten` (also `cpuTime`, `duration`, `storageReadUnits`, …) | `date`, `datetime*`, `namespaceId`, `objectId`, `name`, `coloCode` | Account Analytics Read |
| GraphQL `durableObjectsSqlStorageGroups` | `max.storedBytes` | `date`, `datetime*`, `namespaceId` | Account Analytics Read |
| GraphQL `durableObjectsStorageGroups` | `max.storedBytes` for the KV-backed storage backend; no dimensions | time only | Account Analytics Read |
| GraphQL `durableObjectsInvocationsAdaptiveGroups` | requests; has `scriptName` | `scriptName`, `namespaceId`, `objectId` | Account Analytics Read |
| REST `GET /accounts/{account_id}/workers/durable_objects/namespaces` | maps namespace `id` to `script`, `class`, `name`, `use_sqlite` | – | Workers Scripts Read (or another listed permission) |
| `storage.sql.databaseSize` in the object | bytes of one object's database | per object | – (already in `durableSql`'s `usage()`) |
| Dashboard: Durable Objects → namespace → Metrics | namespace metrics, filterable to one object | – | dashboard login |

Sources and confidence:

- The Durable Objects metrics page lists `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups`, `durableObjectsStorageGroups` and `durableObjectsSubrequestsAdaptiveGroups`. It refers readers to introspection for fields ([metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)). That page does not list `durableObjectsSqlStorageGroups`.
- **The field and dimension lists above are unconfirmed against the live schema.** I had no API token, and the endpoint answers a token-less introspection query with `"Missing X-Auth-Key, X-Auth-Email or Authorization headers"`. They come from two third-party introspection dumps. The first, [`curtcox/cronly` (2026-11-17)](https://github.com/curtcox/cronly/blob/main/docs/ops/evidence/cloudflare-analytics-schema-2026-11-17.json), gives the schema's descriptions: `rowsRead` "Sum of rows read (by sqlite backed DOs)", `rowsWritten` "Sum of rows written (by sqlite backed DOs)", and `AccountDurableObjectsSqlStorageGroupsMax.storedBytes` "Max of stored bytes". It also gives `namespaceId`/`namespaceId_in` filters on `durableObjectsSqlStorageGroups`. The second, [`standardagents/brolly` `docs/cloudflare-datasets.json` (generated 2026-08-18)](https://github.com/standardagents/brolly/blob/main/docs/cloudflare-datasets.json), gives the dimensions listed in the table. To confirm, run the introspection query below.
- Token permission: "select *Account* in the first drop-down list, *Account Analytics* from the second drop-down list, and *Read* from the third" ([GraphQL API token auth](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)). The endpoint is `https://api.cloudflare.com/client/v4/graphql`.
- Namespaces list: [API reference](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/), which gives the response fields `id`, `class`, `name`, `script` and `use_sqlite`.
- Retention: each dataset's `settings` node gives `notOlderThan` ("how far back in time a query can read") and `maxDuration` ([settings](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)). The retention of these two datasets is unconfirmed. Query it with the settings query below before relying on a whole billing period.

## Ready-to-run queries

**1. Map namespaces to stages.** Each `kumora-dashboard-<stage>` Worker owns its own namespaces (`TradingDay`, the day index). Neither GraphQL dataset has `scriptName`, so take the mapping from this call:

```sh
curl -s https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/durable_objects/namespaces?per_page=1000 \
  -H "Authorization: Bearer <TOKEN>" | jq -r '.result[] | [.id, .script, .class, .use_sqlite] | @tsv'
```

**2. Rows read, rows written and stored bytes, per namespace and day.** POST this query to `https://api.cloudflare.com/client/v4/graphql` with `Authorization: Bearer <TOKEN>`. The token needs Account Analytics Read.

```graphql
query DoSqlUsage($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rows: durableObjectsPeriodicGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { date namespaceId }
        sum { rowsRead rowsWritten }
      }
      stored: durableObjectsSqlStorageGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
        orderBy: [date_ASC]
      ) {
        dimensions { date namespaceId }
        max { storedBytes }
      }
    }
  }
}
```

```json
{ "accountTag": "<ACCOUNT_ID>", "start": "2026-11-01", "end": "2026-11-18" }
```

Join the results with step 1 on `namespaceId` to get per-script figures. Use the billing period's own start date. The query was not run (no token), so its argument types (`string!`, `Date!`) and field names are unconfirmed. They follow the dumps above and the docs' own example, which uses `date_gt`, `limit` and `max { storedBytes }`.

**Per object:** add `objectId` to the `rows` dimensions and `namespaceId: "<id>"` to its filter. Storage has no per-object split, so use `storage.sql.databaseSize`.

**3. Check the schema and the retention** before trusting the query. Introspection reads no usage data:

```graphql
{
  sum: __type(name: "AccountDurableObjectsPeriodicGroupsSum") { fields { name description } }
  dims: __type(name: "AccountDurableObjectsPeriodicGroupsDimensions") { fields { name } }
  sqlMax: __type(name: "AccountDurableObjectsSqlStorageGroupsMax") { fields { name description } }
  sqlDims: __type(name: "AccountDurableObjectsSqlStorageGroupsDimensions") { fields { name } }
}
```

```graphql
query ($accountTag: string!) {
  viewer { accounts(filter: { accountTag: $accountTag }) { settings {
    durableObjectsPeriodicGroups { enabled maxDuration notOlderThan }
    durableObjectsSqlStorageGroups { enabled maxDuration notOlderThan }
  } } }
}
```

## Notes for the map

These follow from the measurements. They are pointers for the audit, not the audit itself.

- In `day-store.ts`, `SELECT count(*) AS count FROM trades` reads the **whole trades table** each time it runs: about 1.46 M rows on a full day, by the runbook's volume. So do `count(*) … FROM footprints` and `count(*) … FROM heatmaps` in the storage line, which also sum `length(...)` over every row. `SELECT max(number)` and `min(number)` read 1 row each, so not every aggregate is costly.
- Every `INSERT OR IGNORE INTO trades` costs 1 read as well as at most 1 write. Reads are cheap per row ($0.001 per million), so this matters little.
- In the `GROUP BY code, minute` rebuild over `trades`, in `code IN (SELECT code FROM footprints GROUP BY code)`, and in the `row_number() OVER (PARTITION BY code …)` query, the planner may build a temporary b-tree. If it does, the statement reads its rows 2–4×. Measure each statement in its real form. The harness below takes the statement as written.
- Writes in this schema bill 1 per stored row, with no index overhead: no table has a secondary index, and replaces of `WITHOUT ROWID` rows bill 1. So rows written track how often each row is rewritten, not how big it is.

## Harness

To repeat a measurement, save these two files in an empty directory with a `dodata/` folder in it. Change `path` to that folder's absolute path. Run `node_modules/.pnpm/@cloudflare+workerd-linux-64@<version>/node_modules/@cloudflare/workerd-linux-64/bin/workerd serve config.capnp`, then `curl http://127.0.0.1:18787/`. To measure a real statement, add one line `r("label", "<SQL>", ...bindings)`.

<details>
<summary>config.capnp</summary>

```capnp
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .probeWorker),
               (name = "dodisk", disk = (path = "/abs/path/dodata", writable = true)) ],
  sockets = [ (name = "http", address = "127.0.0.1:18787", http = (), service = "main") ],
);

const probeWorker :Workerd.Worker = (
  modules = [ (name = "worker", esModule = embed "worker.js") ],
  compatibilityDate = "2026-10-01",
  durableObjectNamespaces = [ (className = "Probe", uniqueKey = "probe", enableSql = true) ],
  durableObjectStorage = (localDisk = "dodisk"),
  bindings = [ (name = "PROBE", durableObjectNamespace = "Probe") ],
);
```

`durableObjectStorage = (inMemory = void)` does not work. It fails with "This Durable Object is not backed by SQLite storage".

</details>

<details>
<summary>worker.js (abridged: the setup, and one line for each table row above)</summary>

```js
import { DurableObject } from "cloudflare:workers"

export class Probe extends DurableObject {
  run(label, query, ...bindings) {
    const cursor = this.ctx.storage.sql.exec(query, ...bindings)
    const rows = cursor.toArray()
    return { label, returned: rows.length, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten }
  }

  async fetch() {
    const sql = this.ctx.storage.sql
    const out = []
    const r = (...a) => out.push(this.run(...a))
    r("create trades", `CREATE TABLE IF NOT EXISTS trades (number INTEGER PRIMARY KEY, time INTEGER NOT NULL, code TEXT NOT NULL, price REAL NOT NULL)`)
    r("create candles", `CREATE TABLE IF NOT EXISTS candles (code TEXT NOT NULL, minute INTEGER NOT NULL, close REAL NOT NULL, PRIMARY KEY (code, minute)) WITHOUT ROWID`)
    for (let i = 1; i <= 1000; i++) {
      sql.exec("INSERT INTO trades VALUES (?, ?, ?, ?)", i, i * 10, "C" + (i % 10), i).toArray()
      sql.exec("INSERT INTO candles VALUES (?, ?, ?)", "C" + (i % 10), i, i).toArray()
    }
    r("INSERT OR REPLACE candle, exists", "INSERT OR REPLACE INTO candles VALUES (?, ?, ?)", "C1", 1, 2)
    r("count(*) trades", "SELECT count(*) FROM trades")
    // … one r(...) line for each statement in the tables
    return Response.json(out)
  }
}

export default {
  fetch(request, env) {
    return env.PROBE.get(env.PROBE.idFromName("x")).fetch(request)
  },
}
```

</details>
