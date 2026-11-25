# Can embedded DuckDB 2.0 in a Node service take the trading-day object's load on 2 vCPU and 8 GB?

Research for apinrdw/kumora#536 (map apinrdw/kumora#534). Sources are duckdb.org (the 2.0 docs and DuckDB's blog), the `duckdb/duckdb-node-neo` repo and its issues, and two Bun issues those link to. Read 2026-11-18. DuckDB 2.0.0 LTS shipped on 2026-10-21 ([2.0 announcement][announce]), and `@duckdb/node-api` `2.0.0-r.1` the same day ([node-neo releases][neo-releases]). The workload is the **trading-day object** in `apps/dashboard/src/server/market-live/` and its day store, `day-store.ts`. Nothing here was measured on the box. apinrdw/kumora#539 measures it.

## Short answer

Yes for write volume, with three conditions. The store writes about 6,000 rows a minute on a typical minute and about 35,000 in the busiest minute, all in one transaction a minute. That is the bulk pattern DuckDB's docs ask for, and the Appender is built for it. At this volume, write throughput is not the risk. The conditions are:

1. **The ingest process must serve Quack itself.** Only one process can open a DuckDB file read-write, and other processes reach it only through Quack. A Quack server runs inside an existing DuckDB session. So one Node process per database holds the file, ingests into it, and calls `quack_serve` for the Worker's reads.
2. **Memory must be set by hand for each stage.** `memory_limit` defaults to 80% of RAM and `threads` to the core count, per instance. Several stages on one 8 GB box each need an explicit cap. DuckDB also never evicts ART index buffers, so a `PRIMARY KEY` on a table that keeps every day grows resident memory without bound.
3. **Point reads are the weak side, and nothing published measures them.** DuckDB's own docs say many small concurrent queries are "not a primary design goal". An ART index scan serves equality and `IN` only. The newest 200 trades, the binary search in `highestWithin`, and one code's candles all depend on zonemap pruning and row order. The replay benchmark has to measure them against SQLite.

Node is the supported runtime. The client's CI runs Node 24 only, and its docs never mention Bun. The one Bun crash report was a client race, fixed in `1.5.1-r.2`.

## The load the store puts on a database

From this repo. Volumes come from `docs/research/broker-frame-rates.md`, `docs/research/durable-object-cost.md` and `docs/runbooks/order-flow-cost.md`.

**Ingest.** The relay sends each connection's frames as one message every 250 ms. That is about 16 messages a second across four connections (`durable-object-cost.md`). Folding happens in memory. Only the flush writes to the database.

**Trades.** The busiest measured day had 1.46 M trades (apinrdw/kumora#258). Across a 6 h session that averages about 68 trades a second. Session peaks run 110–202 trades a second. At the open, Stockbit's tape carried 1,990 trades in one second (`broker-frame-rates.md`). Every trade arrives up to four times (two Stockbit and two Ajaib connections), and it is merged and stored once.

**The flush** (`armFlush` in `trading-day.ts`, `write` in `day-store.ts`) runs once a minute, 5 s past the minute (`FLUSH_PAST_MINUTE`), as one transaction:

| Table | Rows a flush writes | Write | Basis |
| --- | --- | --- | --- |
| `trades` | about 4,000 on average; about 30,000 in the peak minute | `INSERT OR IGNORE`, key `number` | 1.46 M / 360 min; `order-flow-cost.md` (peak minute) |
| `candles` | up to about 900 (codes that traded) | `INSERT OR REPLACE`, key `(code, minute)` | about 900 stocks trade |
| `footprints` | about 400–750 | `INSERT OR REPLACE` | 150–270 K stock-minutes a day |
| `book_chunks`, `heatmaps` | 30–100 each, gzipped blob or JSON | `INSERT OR REPLACE` | K = 30–100 codes with books |
| `live_prices` | up to the code count (690 to 3,406 listed) | `INSERT OR REPLACE` | `broker-frame-rates.md` |
| `ajaib_books`, `facts` | a few | `INSERT OR REPLACE` | |

So the store writes **about 6,000 rows a minute on average and about 35,000 at the peak**, or about 100–600 rows a second spread over the minute. The day store is 0.3–1.5 GB a day (an estimate in `durable-object-cost.md`). Trades are in number order, which IDX hands out in time order (the `Decision:` on `highestWithin`).

**Reads.** A live viewer's Select (`viewerMessage` in `trading-day.ts`) takes its 200 newest trades from the in-memory tape (`SNAPSHOT_TRADES` = 200, `TAPE_LIMIT` = 10,000), not from the database. Per Select it reads the following from the store:

- The selected code's candles and footprints: `WHERE code = ? ORDER BY minute`, up to about 360 rows each (`storedCandlesOf`, `storedFootprintsOf`, via `candlesOf` and `footprintsOf` in `candles.ts`).
- One `storedCandlesOf(code, after)` range read for each watched code's day state, about 30 codes.

A restart reads the newest 10,000 trades and the trades since the tape, the latest book chunks, the live prices, and `storedBubbles`. `storedBubbles` makes two passes over about 400,000 candle rows (its `Decision:`).

A recorded-day GET (`recorded-answers.ts`) runs `tradesAt`, which is a binary search of about 21 point queries (`number >= ? ORDER BY number LIMIT 1`) followed by a 200-row `ORDER BY number DESC LIMIT`. It also reads one code's candles, footprints and heatmap, or one book chunk by `(code, minute)`.

## Concurrency: one writer process, Quack for everyone else

| Fact | Source |
| --- | --- |
| "Read-write mode: one process can both read and write to the database." "Read-only mode: multiple processes can read from the database, but no processes can write." | [Concurrency][concurrency] |
| Inside one process, read-write mode supports several writer threads under MVCC with optimistic concurrency. "Appends will never conflict, even on the same table." Two writers that update or delete the same row conflict, and the second one fails. | [Concurrency][concurrency] |
| "Writing to DuckDB's native database format from multiple processes is supported through the Quack remote protocol", which "turns DuckDB into a client-server database". DuckLake with a PostgreSQL catalog is the other route. | [Concurrency][concurrency] |
| DuckDB manages concurrent access with file locks. | [Concurrency][concurrency] |
| "A server is started from an existing DuckDB session": `CALL quack_serve('quack:localhost')`. The call returns the URI, the HTTP URL and a generated token. | [Quack overview][quack] |
| `quack_serve` has no parameter that picks a database or catalog, and none for read-only. `quack_server_max_connections` defaults to 1,024. One instance can run several servers (`quack_server_list()`). | [Quack reference][quack-ref] |
| Transport is HTTP, or HTTPS for non-local hosts. "Every interaction is initiated by the client." Server pushes are not part of the protocol. The default port is 9494. | [Quack overview][quack] |
| The server binds only to localhost unless `allow_other_hostname` is set. DuckDB advises against exposing a Quack endpoint directly to the internet. | [Quack reference][quack-ref]; [Quack blog][quack-blog] |
| Quack clients are other DuckDB instances, including DuckDB-Wasm. | [Quack overview][quack]; [Quack blog][quack-blog] |
| "Multiple instances in the same process should not attach the same database." The client offers `DuckDBInstance.fromCache` to prevent that. | [node-api README][neo-readme] |
| A transaction can write to only one attached database. Atomicity does not hold across attached files. | [ATTACH][attach] |

**What this means for the box** (inference from the rows above):

- A separate Quack server process cannot open a file that the ingest process holds read-write. Read-only openers are also excluded while a writer holds the file. So there are two possible shapes:
  - **(a)** The ingest process opens the file, writes with its own connections, and calls `quack_serve` from the same instance. The Worker's reads arrive as Quack queries on that instance and run next to the ingest.
  - **(b)** A separate DuckDB process owns the file and serves Quack. The Node ingest becomes a Quack client and sends each flush over loopback HTTP.

  Shape (a) has one fewer process and no network hop on writes. In both shapes the same process runs reads and writes, so a slow viewer query competes with the flush for the same two cores.
- With one Node process per stage, every stage needs its own Quack port, or one reverse proxy in front of all of them. With one process for every stage (one instance with an `ATTACH` per stage database), a single `quack_serve` exposes every attached database to any client with the token. The docs give no per-database scope or token. Isolating stages therefore argues for one process, or at least one instance, per stage. apinrdw/kumora#535 and #537 own the Worker side of Quack.
- A Quack client that sends a flush as a single statement or a single transaction makes one round trip. DuckDB's blog measured 0.28 ms ping between VMs in the same availability zone, and about 1,000 single-thread small-write transactions a second against a Quack server ([Quack blog][quack-blog]). One flush a minute is far below that.

## Small inserts against the Appender

| Fact | Source |
| --- | --- |
| "avoid using lots of individual row-by-row INSERT statements when inserting more than a few rows". Maximise the rows per statement. In auto-commit mode "every single statement will be wrapped in a separate transaction, meaning `fsync` will be called for every statement". Wrap loops in `BEGIN TRANSACTION` / `COMMIT`. | [INSERT guide][insert-guide] |
| "Appenders are the most efficient way of loading data into DuckDB from within the C interface." "The appender is much faster than using prepared statements or individual `INSERT INTO` statements." | [C Appender][c-appender] |
| If a flush hits a constraint violation, "all data is invalidated". | [C Appender][c-appender] |
| The Node appender flushes on `flushSync()` and `closeSync()`, and on its own about every 204,800 rows. Since 2.0, an appender cannot flush while its connection has an unread streaming or pending result. The rows appended since the last flush are then lost. The README says to append on a separate connection. | [node-api README][neo-readme] |
| `flushSync` and `closeSync` are synchronous. An issue to add async versions is still open. | [node-neo #155][neo-155] |
| `INSERT OR IGNORE` and `INSERT OR REPLACE` need a `PRIMARY KEY` or `UNIQUE` constraint. When one statement holds the same key twice, "DuckDB applies only one update per conflicting key", and the winner is "not guaranteed to be the last one in insertion order". | [INSERT statement][insert-stmt] |
| On DuckDB's own small-write benchmark through Quack, single-row transactions ran at 1,038 a second on 1 thread and 5,434 on 8 threads. Past 8 threads, a limit on concurrent inserts into one table holds them back. | [Quack blog][quack-blog] |

**Inference for this store:**

- The flush already has the documented good shape: one transaction a minute with thousands of rows. Keeping thousands of separate `INSERT` statements inside that one transaction avoids an fsync per row. It still parses and plans every statement, and the binary search's point statements cost the same way. Using the Appender, or one multi-row `INSERT ... SELECT` from an appended staging table, is the documented fast path.
- Four of the store's writes cannot go through a plain Appender: `INSERT OR IGNORE` on `trades` and `INSERT OR REPLACE` on the others. An Appender row that hits the primary key invalidates the whole flush. One shape that keeps the upsert is to append into an unkeyed staging table, then run `INSERT OR REPLACE INTO candles SELECT ... FROM staging` in the same transaction. A flush must not carry the same key twice, because only one of the duplicates wins and which one is not defined. The store's in-memory maps already keep one row per `(code, minute)`.
- `flushSync` runs on the JavaScript thread. A 35,000-row flush blocks the event loop for its full duration, as `transactionSync` blocks the object today (`durable-object-ingest-limits.md`). Ordinary queries run on libuv's thread pool, which has four threads by default and is shared with `fs` and `zlib` ([node-neo #325][neo-325]). The `startStreamThenReadAll` helpers split a query into short tasks to keep a pool thread free ([node-api README][neo-readme]).

## WAL, checkpoints and what a crash loses

| Fact | Source |
| --- | --- |
| DuckDB writes a WAL and "explicitly calls the `fsync()` system call to make sure any WAL entries will be forced to be written to persistent storage". | [Concurrent transactions blog][txn-blog] |
| A checkpoint runs automatically "whenever the WAL file reached a limit, by default 16 MB" (`checkpoint_threshold`), and at shutdown. `CHECKPOINT` waits for running transactions. `FORCE CHECKPOINT` rolls back the active transactions. | [Concurrent transactions blog][txn-blog]; [Configuration][config] |
| On restart, DuckDB reloads the database file and re-applies the WAL. | [Concurrent transactions blog][txn-blog] |
| A process killed with SIGKILL before `COMMIT` loses that transaction. Committed transactions survive. | [ACID blog][acid-blog] |
| `fsync_mode` is `STANDARD` by default (fsync or fdatasync on Linux). `FULL` differs only on macOS. `NONE` "may cause database corruption after an operating system or hardware crash". The setting is global to the instance. | [Configuration][config] |
| "Compression is applied when the data is checkpointed." | [Tuning workloads][tuning] |
| The docs do not say whether a checkpoint blocks readers or writers while it runs. | (absent from [txn-blog], [concurrency]) |
| The 2.0 storage format adds checkpoint vacuuming that compacts tables with ART indexes. DuckDB before 2.0 cannot read files that 2.0 created. | [2.0 highlights][highlights]; [2.0 announcement][announce] |

**Inference for this store:**

- A crash loses what has not been committed. With one flush a minute, that is up to about 65 s of folded state: the trades, candles and book chunks since the last flush, held in memory. This is the same window the object has today (`durable-object-cost.md`, choice 8). Committed flushes survive a process kill, and with `fsync_mode = STANDARD` they also survive an OS crash on a disk that honours fsync. The map's failure model already fills trade gaps from backfill and the REST tapes, so only book chunks from that last minute are gone for good.
- At about 6,000 rows a minute, a 16 MB WAL fills in tens of minutes, and an automatic checkpoint then runs during the session. The docs do not say how long a checkpoint takes or whether it stalls the next flush or a viewer read. The replay must time it.
- DuckDB applies compression at checkpoint, and the store's on-disk size depends on it. A day's size on disk is therefore known only after the replay runs and checkpoints.

## Memory and threads for several databases on 8 GB

| Fact | Source |
| --- | --- |
| `memory_limit` defaults to "80% of RAM". `threads` defaults to the number of CPU cores. Both are global (per instance) settings. | [Configuration][config] |
| "Aim for 1-4 GB memory per thread." The minimum is 125 MB per thread. Aggregation-heavy work needs 1–2 GB per thread, and join-heavy work 3–4 GB. | [Environment][environment] |
| Disk mode "is designed to work best with SSD and NVMe disks". HDD writes are slow. Do not use read-write mode on network-attached storage. | [Environment][environment] |
| Larger-than-memory work spills to `temp_directory`, which can grow to 90% of free disk by default (`max_temp_directory_size`). 2.0 adds spilling for aggregations. | [Configuration][config]; [Tuning workloads][tuning]; [2.0 highlights][highlights] |
| ART indexes "must currently be able to fit in memory during index creation". "DuckDB does not yet destroy any index buffers if it has to evict memory." Index memory is deserialized lazily on attach. | [Indexes][indexes]; [Indexing guide][indexing] |
| An ART index is created for every `PRIMARY KEY` or `UNIQUE` column. It slows loading and updates. | [Indexes][indexes] |
| DuckDB "may launch too many threads (e.g., due to HyperThreading), which can lead to slowdowns". | [Tuning workloads][tuning] |
| Instances can be given settings at creation: `DuckDBInstance.create(path, { threads: '4' })`. | [node-api README][neo-readme] |

**Inference for this box:**

- Every instance left at the defaults would claim up to 6.4 GB and both cores. Each stage's instance needs an explicit `memory_limit` and `threads`. For example: Production `memory_limit = '2GB'` with `threads = 2`, Staging 1 GB, and each preview 256–512 MB with `threads = 1`. All of them together must also leave room for Node's heap, the in-memory fold (the object today fits in 128 MB), the page cache and the OS. These figures are a starting point for the replay, not a sizing.
- Two vCPUs give DuckDB at most two threads. Running more threads than cores across several stages adds contention. Production's ingest, its Quack reads and every preview share the same two cores.
- **ART memory is the unbounded term.** The map keeps every recorded day forever. If `trades` is one table across all days with `number` as `PRIMARY KEY`, as in the SQLite schema today, its ART holds every trade number ever stored, about 32 M a month. The docs say those buffers are never evicted under memory pressure. The same holds for the `(code, minute)` keys of the other tables. Splitting by day bounds the index that the ingest touches to one day. That can mean a table per day, a database file per day, or a key that includes the day. It is also how the object stores data today: one database per day.
- `ATTACH` many day files into one instance: they then share one `memory_limit` (inference, because the limit is per instance). A transaction can write to only one of them, which matches one live day.

## Bun or Node

| Fact | Source |
| --- | --- |
| The package is "An API for using DuckDB in Node", built on DuckDB's C API through a native addon. It supports Linux x64 and arm64 on glibc and musl. | [node-api README][neo-readme] |
| The client's CI sets up Node 24 and nothing else. The README never mentions Bun or Deno. | [node-neo workflow][neo-ci]; [node-api README][neo-readme] |
| "Crashes opening databases on bun" ([oven-sh/bun#17216][bun-17216]) turned out to be a client race with finalization, which also reproduced on Node. It was fixed in `1.5.1-r.2`. The maintainer: "Bun has likely improved their Node Addon API support since then. Please file a new issue if you see something like this again." | [node-neo #151][neo-151] |
| Bun closed its "duckdb compatibility" issue on 2026-07-24. | [oven-sh/bun#13910][bun-13910] |

**Inference:** Node 24 is the tested runtime. Bun may work through its Node-API layer, but nobody tests it upstream, and a native-addon crash takes the box's only ingest down. Run Node, unless the replay also runs under Bun and stays clean for a whole day.

## Point reads next to SQLite

| Fact | Source |
| --- | --- |
| "it is not a primary design goal for DuckDB to quickly execute many small queries concurrently". It is "optimized for running larger, less frequent queries". "DuckDB will perform best when reusing the same database connection many times." | [Tuning workloads][tuning] |
| Two index types exist. Every column gets min-max zonemaps automatically. ART serves "point and very highly selective (i.e., < 0.1%) queries". | [Indexes][indexes] |
| An index scan is used "for equality and `IN(...)` conditions", only on a single-column index without expressions. ART "does not affect the performance of join, aggregation, and sorting queries". | [Indexing guide][indexing] |
| Data that is inserted pre-sorted on a selective filter column prunes better: "Even an imperfect ordering will still be helpful." | [Indexing guide][indexing] |
| Row group size is set per database, for example `ATTACH ... (ROW_GROUP_SIZE 16384)`. | [Storage][storage] |
| DuckDB's 2019 paper describes SQLite as a row-major engine on a B-tree, built for OLTP. | [SIGMOD 2019 demo][sigmod] |
| DuckDB publishes no point-lookup benchmark against SQLite. | (none found on duckdb.org) |

**Inference, for each read the store makes:**

- **Newest 200 trades** (`ORDER BY number DESC LIMIT 200`). This is a top-N over the trades table. It is not an equality lookup, so ART does not serve it. Trades arrive in number order, so the row groups' zonemaps on `number` are almost sorted. Adding a filter such as `WHERE number > max - k` lets DuckDB prune to the last row group. Without that filter, the docs do not promise that a top-N skips the rest of the table. In SQLite the same query walks the rowid B-tree from its end. The live tape is served from memory, so this read matters for restarts and recorded-day GETs, not for every Select.
- **`highestWithin`'s binary search** makes about 21 sequential `number >= ? ORDER BY number LIMIT 1` queries. Each is a cheap B-tree probe in SQLite. In DuckDB each one is a full query with planning, and with zonemaps only. A columnar engine can answer the same question in one statement, `SELECT max(number) FROM trades WHERE time <= ?`. That would replace 21 round trips, and over Quack, 21 HTTP calls.
- **One code's candles or footprints** (`WHERE code = ? ORDER BY minute`, about 360 rows). The `(code, minute)` primary key builds an ART on two columns, and the docs restrict index scans to single-column indexes. So this read runs on zonemaps. Rows land in minute order with every code mixed in, so zonemaps on `code` prune little, and the query scans the day's candles: about 400,000 rows on a busy day. That is fast in a columnar scan (inference: milliseconds), but it is not the B-tree seek SQLite does, and the Select runs it about 30 times for the day states.
- **Many cross-day analytics** (the map's reason for DuckDB) are what DuckDB is built for. That is where it beats SQLite outright.

## Open points the replay benchmark must measure (apinrdw/kumora#539)

1. **Flush time** at the peak minute (about 35,000 rows): `INSERT` in one transaction against an Appender into a staging table plus `INSERT OR REPLACE ... SELECT`. Measure the CPU and how long the event loop stays blocked during `flushSync`.
2. **Checkpoint stalls.** How long an automatic 16 MB checkpoint takes mid-session, and whether the next flush or a Quack read waits on it. Test `checkpoint_threshold` higher and lower.
3. **Point-read latency, DuckDB against SQLite (`node:sqlite`), on one replayed busy day:** newest 200 trades, `tradesAt`'s binary search against one `max(number)` query, one code's candles (`WHERE code = ?`), and the 30 day-state reads of one Select. Measure p50 and p99, in process and over Quack on loopback.
4. **Memory.** Resident size of one stage's instance across a full day and across 30 stored days, with and without the `PRIMARY KEY` on `trades`. This shows how fast ART grows when it is never evicted.
5. **Several stages at once.** Production at full load, plus Staging and two previews, each with its `memory_limit` and `threads`. Measure Production's flush and read times while the others run.
6. **Crash loss.** `kill -9` mid-session and confirm that every committed flush comes back after WAL replay. Time the replay.
7. **Disk.** Bytes on disk per day after checkpoint compression, against the 0.3–1.5 GB estimate.
8. **Bun.** Run the same replay under Bun only if Bun is still a candidate, and count crashes.
9. **Quack under a Quack read.** Whether `quack_serve`'s HTTP handling uses the instance's `threads` or its own, and the CPU a Worker read costs the ingest process. The docs are silent on both.

[announce]: https://duckdb.org/2026/10/21/announcing-duckdb-200
[highlights]: https://duckdb.org/2026/08/17/duckdb-20-highlights
[concurrency]: https://duckdb.org/docs/2.0/connect/concurrency.html
[quack]: https://duckdb.org/docs/2.0/quack/overview.html
[quack-ref]: https://duckdb.org/docs/2.0/quack/reference.html
[quack-blog]: https://duckdb.org/2026/05/12/quack-remote-protocol
[attach]: https://duckdb.org/docs/2.0/sql/statements/attach.html
[insert-guide]: https://duckdb.org/docs/2.0/data/insert.html
[insert-stmt]: https://duckdb.org/docs/2.0/sql/statements/insert.html
[c-appender]: https://duckdb.org/docs/2.0/clients/c/appender.html
[config]: https://duckdb.org/docs/2.0/configuration/overview.html
[tuning]: https://duckdb.org/docs/2.0/guides/performance/how_to_tune_workloads.html
[environment]: https://duckdb.org/docs/2.0/guides/performance/environment.html
[indexes]: https://duckdb.org/docs/2.0/sql/indexes.html
[indexing]: https://duckdb.org/docs/2.0/guides/performance/indexing.html
[storage]: https://duckdb.org/docs/2.0/internals/storage.html
[txn-blog]: https://duckdb.org/2024/10/30/analytics-optimized-concurrent-transactions.html
[acid-blog]: https://duckdb.org/2024/09/25/changing-data-with-confidence-and-acid
[sigmod]: https://duckdb.org/pdf/SIGMOD2019-demo-duckdb.pdf
[neo-readme]: https://github.com/duckdb/duckdb-node-neo/blob/main/api/pkgs/%40duckdb/node-api/README.md
[neo-releases]: https://github.com/duckdb/duckdb-node-neo/releases
[neo-ci]: https://github.com/duckdb/duckdb-node-neo/blob/main/.github/workflows/DuckDBNodeBindingsAndAPI.yml
[neo-151]: https://github.com/duckdb/duckdb-node-neo/issues/151
[neo-155]: https://github.com/duckdb/duckdb-node-neo/issues/155
[neo-325]: https://github.com/duckdb/duckdb-node-neo/issues/325
[bun-17216]: https://github.com/oven-sh/bun/issues/17216
[bun-13910]: https://github.com/oven-sh/bun/issues/13910
