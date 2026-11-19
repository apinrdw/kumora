# Measure what Durable Object SQL costs

Spec [apinrdw/kumora#556](https://github.com/apinrdw/kumora/issues/556), from the research in [apinrdw/kumora#552](https://github.com/apinrdw/kumora/issues/552). Workers Paid bills a Durable Object by the SQL rows it reads, the rows it writes and the data it stores. Cloudflare's GraphQL Analytics API holds the billed figures. This runbook reads them, splits them by stage, by object and by hour, and compares them with the thresholds below.

You need only a Cloudflare API token and Node 22 or later. An agent can run every step once the owner gives it the token.

## The thresholds

The prices are Cloudflare's Durable Object SQLite prices on Workers Paid, read 2026-11-14 from <https://developers.cloudflare.com/durable-objects/platform/pricing/>. The included amounts are for the whole account each month: 50 M rows written, 25 B rows read and 5 GB-month stored. Over them, rows written cost $1.00 a million, rows read $0.001 a million and storage $0.20 a GB-month.

A busy day is Production's busiest measured day, 1,460,000 trades ([apinrdw/kumora#258](https://github.com/apinrdw/kumora/issues/258), 2026-11-13). Each threshold keeps a month of 22 busy days inside the included amounts:

| What | Threshold | Where you read it |
| --- | --- | --- |
| Rows written for a busy day | ≤ 2 M | the day's object, summed over every hour ([Split by object and hour](#split-by-object-and-hour)) |
| Rows read for a busy day | ≤ 0.5 B | the same sum |
| Storage of one hot day | ≤ 0.4 GB | the day's `Order flow storage` line, `databaseBytes` ([Split by table](#split-by-table-from-workers-logs)) |
| Storage of Production's `TradingDay` namespace | ≤ 5 GB | `storedBytes` from the daily mode ([Split by stage](#split-by-stage)) |

A hot day is a recorded day that still lives in its object. A cold day lives in R2 and bills no SQL rows. `apps/dashboard/GLOSSARY.md` defines both.

The row-budget suite checks the same budgets in workerd before a deploy, on a modelled busy day. Run `pnpm --filter dashboard test:row-budgets` for each operation's budget. Run `pnpm --filter dashboard test:whole-day --silent=false` for a whole recorded day: it takes about 5.5 minutes and is not part of `pnpm check`.

## Every cost Decision states rows billed

A `Decision:` comment that justifies a choice by its cost states the rows billed, read and written, and where the figure came from. A figure in milliseconds alone is not enough: Cloudflare bills a full-table scan that finishes in 20 ms as every row it visits. For example, `unfieldedOf` in `apps/dashboard/src/server/market-live/broker-codes.ts`:

```ts
// Decision: a day whose tape summary is built reads it, not the tape: a
// status pass on a 1.46M-trade sealed day bills about 3 K rows read, the
// chunks and their summary rows, against 2.7 M counting the tape
// (row-budgets.workerd.test.ts). See apinrdw/kumora#543.
```

## Before you start

1. Ask the owner for a Cloudflare API token with these two permissions:
   - **Account Analytics Read**, for the GraphQL datasets.
   - **Workers Scripts Read**, for the list that maps a namespace ID to its Worker.

   The token is not stored anywhere. An agent asks with `request_secret`, file delivery, and reads the file only inside the command.
2. Write down the account ID, `8ecc24065089e01c57d5470fa0848f9a`. Production's `TradingDay` namespace is `295e30c501fb411daf0a7f125637c301`.
3. Save the script below as `do-usage.mjs` in an empty directory outside the repo. It ran as written on 2026-11-18 ([apinrdw/kumora#532](https://github.com/apinrdw/kumora/issues/532)).

<details><summary><code>do-usage.mjs</code></summary>

```js
// Usage:
//   node do-usage.mjs <tokenFile> <accountId> <startDate> <endDate> <outDir> daily
//   node do-usage.mjs <tokenFile> <accountId> <startHour> <endHour> <outDir> hourly <namespaceId>
import { readFileSync, writeFileSync } from "node:fs"

const [tokenFile, account, start, end, out] = process.argv.slice(2)
const token = readFileSync(tokenFile, "utf8").trim()
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

const gql = async (query, variables) => {
	const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers,
		body: JSON.stringify({ query, variables }),
	})
	const body = await res.json()
	if (body.errors) throw new Error(JSON.stringify(body.errors))
	return body.data.viewer.accounts[0]
}

const ns = await (
	await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`,
		{ headers }
	)
).json()
const names = Object.fromEntries(ns.result.map((n) => [n.id, { script: n.script, cls: n.class }]))

const mode = process.argv[7] ?? "daily"
if (mode === "daily") {
	const data = await gql(
		`query($a: string!, $s: Date!, $e: Date!) { viewer { accounts(filter: {accountTag: $a}) {
			rows: durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}) {
				dimensions { date namespaceId } sum { rowsRead rowsWritten } }
			stored: durableObjectsSqlStorageGroups(limit: 10000, filter: {date_geq: $s, date_leq: $e}) {
				dimensions { date namespaceId } max { storedBytes } }
		} } }`,
		{ a: account, s: start, e: end }
	)
	const label = (id) => names[id] ?? { script: `unknown:${id}`, cls: "?" }
	writeFileSync(
		`${out}/daily.json`,
		JSON.stringify(
			{
				rows: data.rows.map((r) => ({ ...r.dimensions, ...label(r.dimensions.namespaceId), ...r.sum })),
				stored: data.stored.map((r) => ({ ...r.dimensions, ...label(r.dimensions.namespaceId), ...r.max })),
			},
			null,
			1
		)
	)
	console.log("rows", data.rows.length, "stored", data.stored.length)
} else {
	const nsId = process.argv[8]
	const data = await gql(
		`query($a: string!, $s: Time!, $e: Time!, $n: string!) { viewer { accounts(filter: {accountTag: $a}) {
			rows: durableObjectsPeriodicGroups(limit: 10000, filter: {datetimeHour_geq: $s, datetimeHour_lt: $e, namespaceId: $n}) {
				dimensions { datetimeHour objectId name } sum { rowsRead rowsWritten } }
		} } }`,
		{ a: account, s: start, e: end, n: nsId }
	)
	writeFileSync(
		`${out}/hourly-${nsId}.json`,
		JSON.stringify(data.rows.map((r) => ({ ...r.dimensions, ...r.sum })), null, 1)
	)
	console.log("rows", data.rows.length)
}
```

</details>

The script reads three sources:

- `durableObjectsPeriodicGroups`: `rowsRead` and `rowsWritten`, by date or hour, namespace and object.
- `durableObjectsSqlStorageGroups`: `storedBytes`, by date and namespace only. No dataset gives storage for one object.
- The REST namespaces list, `GET /accounts/{id}/workers/durable_objects/namespaces`: the Worker (`script`) and class of each namespace ID.

The datasets go back to at least 2026-10-18. Dates and hours are UTC. A WIB trading day's live hours, 09:00–16:15 WIB, are 02:00–09:15 UTC on the same date.

## Split by stage

1. Run the daily mode over the dates you want:

   ```sh
   node do-usage.mjs <tokenFile> 8ecc24065089e01c57d5470fa0848f9a 2026-11-01 2026-11-18 . daily
   ```

2. Sum the rows by Worker and class:

   ```sh
   jq '.rows | group_by([.script, .cls]) | map({script: .[0].script, cls: .[0].cls, rowsRead: (map(.rowsRead) | add), rowsWritten: (map(.rowsWritten) | add)}) | sort_by(-.rowsRead)' daily.json
   ```

3. Read the stage from the Worker name. `kumora-dashboard` is Production, `kumora-dashboard-staging` is Staging, and `kumora-dashboard-<slug>-<hash>` is a Preview (`packages/deploy/GLOSSARY.md`). `alchemy-state-store` is Alchemy's own state, not kumora's.
4. Read the namespace's storage for each date:

   ```sh
   jq -r '.stored[] | select(.script == "kumora-dashboard" and .cls == "TradingDay") | [.date, .storedBytes / 1e9] | @tsv' daily.json
   ```

   Compare the newest date with the 5 GB threshold.

## Split by object and hour

Each `TradingDay` object holds one WIB trading day, and its `name` is that date, such as `2026-11-17`. The one `DayIndex` object is named `index`.

1. Run the hourly mode for one namespace. Keep the window to a few days: the query returns at most 10,000 rows, one for each object and hour.

   ```sh
   node do-usage.mjs <tokenFile> 8ecc24065089e01c57d5470fa0848f9a 2026-11-16T00:00:00Z 2026-11-19T00:00:00Z . hourly 295e30c501fb411daf0a7f125637c301
   ```

2. Sum each object over the window:

   ```sh
   jq 'group_by(.name) | map({name: .[0].name, rowsRead: (map(.rowsRead) | add), rowsWritten: (map(.rowsWritten) | add)}) | sort_by(-.rowsRead)' hourly-295e30c501fb411daf0a7f125637c301.json
   ```

   For a busy day's totals, run a window that covers the day's live hours and every night after them until its walk is done. Compare the day's sums with the 2 M and 0.5 B thresholds.
3. List one object's hours to see when it read and wrote:

   ```sh
   jq -r --arg day 2026-11-17 'map(select(.name == $day)) | sort_by(.datetimeHour) | .[] | [.datetimeHour, .rowsRead, .rowsWritten] | @tsv' hourly-295e30c501fb411daf0a7f125637c301.json
   ```

   Rows during 02:00–09:15 UTC on the object's own date are live trading. Later rows are the seal, the evening walk and any later reads of the sealed day. A cold day's object bills no rows after its move.
4. If an hour reads far more than its writes explain, divide its rows read by its requests. That gives the rows each request read. Get the requests from `durableObjectsInvocationsAdaptiveGroups`, as `sum { requests }`, filtered by the same namespace and hour.

## Split by table from Workers Logs

GraphQL bills a whole object. For the rows each table wrote, read the meter lines that the trading-day object logs to Workers Logs (`trading-day.ts` logs them, from the meter in `day-store.ts`). The Query Builder keeps logs for seven days, so read them within a week of the day. Cloudflare's [Query Builder page](https://developers.cloudflare.com/workers/observability/query-builder/), read 2026-11-14, gives the path: Workers & Pages, the Worker, then Observability.

- **`Rows written`**: one line for each flush, about once a minute while the day records. Each field counts the rows that flush wrote to one table. `billedRowsWritten` is what the SQLite cursors counted, which is what Cloudflare bills.
- **`Sweep brokers recomputed`**: after the seal, one line for each sweep brokers recompute, with the same fields. The Decision above `recomputeLogged` in `sweep-brokers.ts` says which line carries a batch's counts.
- **`Order flow storage`**: one line at the seal, and one more when the object first finds the sealed day's broker codes complete. `databaseBytes` is the size of the whole day's database. Compare the day's last line with the 0.4 GB threshold.

To read them, filter on the message (the `$metadata.message` key) and the day, then sum each field across the lines. The meter counts the rows a flush or a batch wrote. It does not count the rows that a GET reads, so it can't replace GraphQL for rows read.

## Cold days in R2

A cold day's answers live in the stage's days bucket, which `apps/dashboard/alchemy.run.ts` declares. R2 bills storage and operations, not SQL rows. Once the backfill of older days ends, report R2's storage and operations for the month from the bucket's metrics in the Cloudflare dashboard (R2, the bucket, then Metrics). That path and the GraphQL datasets for R2 are unconfirmed.

## Why the old estimate missed the reads

Before 2026-11-18 this runbook estimated cost from one Staging day. It summed the `Rows written` lines, scaled them to Production's busy day, and priced rows read at $0.001 a million. It counted only the reads it knew of: late trades that read a stored minute back, and sweep brokers recomputes. Its first estimate (2026-11-14) assumed 150 K stock-minutes a day, 0.3 sweeps a trade and 30 codes with books. It expected about $6 in month 1 and a namespace that grew 3.4 GB a month.

The bill disagreed. Production's `TradingDay` read 44 B rows and wrote 56 M from 2026-11-01 to 2026-11-18, and its storage reached 7.44 GB, growing 1.3–1.8 GB a trading day ([apinrdw/kumora#532](https://github.com/apinrdw/kumora/issues/532)). The model missed in three ways:

- **It measured writes, not reads.** 99.96 % of the reads landed after the close, on sealed days, with almost no writes. Each broker codes status GET scanned every trade of the day, about 1.6 M rows, and the extension asked about every 16 s all night. A sealed day billed about 3.5 B rows a night. The meter lines never saw these reads, because they count writes and two kinds of re-read.
- **It took the time of a query for its cost.** A scan that finishes in milliseconds still bills every row it visits ([apinrdw/kumora#530](https://github.com/apinrdw/kumora/issues/530)). Hence the rule that every cost `Decision:` states rows billed.
- **It assumed storage was small and kept every day.** Each recorded day stayed in its object for good, about ten times the estimated size. Cold days move to R2 for that reason (spec [apinrdw/kumora#556](https://github.com/apinrdw/kumora/issues/556)).

GraphQL reports what Cloudflare bills, for every operation and every object, so this runbook now measures it instead of estimating from logs.
