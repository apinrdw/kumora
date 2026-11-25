# A recorded day replayed into DuckDB on the Hostinger box

Research for apinrdw/kumora#539 (map apinrdw/kumora#534). Measured on the box (`ssh kumora-box`: Hostinger KVM 2, 2 vCPU, 7.8 GiB, Ubuntu 24.04) on 2026-11-18, with Multica, Firecrawl and Traefik running as usual. The input is the sealed Production day 2026-11-17: 1,416,482 trades, rebuilt into relay envelopes. Node 24.22.3, `@duckdb/node-api` with DuckDB 2.0. The prototype (`prototypes/duckdb-replay/`, cited by file name below) is not on this branch: the repo's fallow commit gate rejects it as unused files with an unlisted `@duckdb/node-api`. It lives on the box in `/opt/kumora-bench/replay/`, next to each run's JSON lines and `summary.json`, `inspect.json`, `compare.json` and `kill.jsonl` in `/opt/kumora-bench/results/<run>/`. This answers open points 1, 2, 3 (in process only), 5, 6 and 7 of `duckdb-embedded-ingest-load.md`.

## Short answer

The box takes the write load easily, and the viewer reads are where DuckDB falls short. At 5x speed over the whole day, the ingest used 0.27 cores at p50 and 0.79 at p99, and its RSS peaked at 1.18 GiB. The box never ran short of memory: at least 2.4 GiB stayed available. A row shows to a reader 40 ms after its flush commits (p50). The once-a-minute flush sets the receipt-to-visible lag, not DuckDB: at real speed, the lag is 35 s at p50 and 65.6 s at most. A `kill -9` lost no committed row, and the restart reopened the file in 128 ms.

Two limits remain:

1. **Each DuckDB statement costs about 3 ms, even on an idle box.** SQLite (`node:sqlite`) on the same data costs 0.15–0.9 ms. The reads that run many statements pay this once per statement. `highestWithin`'s binary search took 55 ms against SQLite's 0.5 ms. The 30 day-state reads of one Select took 93 ms against 3.9 ms. When the same search runs as one `max(number) WHERE time <= ?` statement, both engines take 8–9 ms.
2. **Checkpoints get slower as the day grows.** DuckDB checkpoints automatically about every 9 flushes (16 MB WAL). The checkpoint runs inside the flush's `COMMIT`. In the full-day run, that commit took 0.25 s at p50 and 4.1 s at worst (13:31 WIB). A viewer read caught behind it waited 3.7 s. Without a checkpoint, a commit takes 14 ms at p50.

So DuckDB can be the store only if the viewer reads change shape: each read must become one statement, or be served from the ingest's in-memory fold. Checkpoints also need a schedule that keeps them out of the viewer's path. A full day takes 415 MB on disk after the last checkpoint.

## Runs

Each run is `prototypes/duckdb-replay/run.sh` on the box. It starts `ingest.mjs` (decode, merge, fold, the once-a-minute flush and a viewer reading once a second, all in one process), `feeder.mjs` (the relay stand-in: four copies of each trade, two copies of each book frame, one order-flow envelope after each minute closes), and a `docker stats` sampler every 30 s. At the end, the ingest checkpoints and runs 300 idle read rounds. `summarize.mjs` reduces the JSON lines, `inspect.mjs` counts rows and bytes, and `compare.mjs` compares two databases.

| Run | Command (on the box, in `/opt/kumora-bench`) | Window (WIB) | Speed | Wall time |
| --- | --- | --- | --- | --- |
| a | `replay/run.sh a duckdb prod:db/a.duckdb:1500MB:2 input 08:55 10:00 1` | 08:55–10:00 | 1x | 65 min |
| b | `replay/run.sh b duckdb prod:db/b.duckdb:1500MB:2 input 08:55 16:30 5` | whole day | 5x | 91 min |
| c | `replay/run.sh c duckdb prod:…:1500MB:2,staging:…:512MB:1,preview:…:256MB:1 input 08:55 09:35 5` | 08:55–09:35 | 5x | 8 min |
| d | `replay/run.sh d sqlite prod:db/d.sqlite input 08:55 10:00 5` | 08:55–10:00 | 5x | 13 min |
| e | `replay/run.sh e duckdb prod:db/e.duckdb:1500MB:2 input 08:55 10:00 5`, plus `replay/kill-test.sh e 6 5` | 08:55–10:00 | 5x | 13 min |
| idle A/B | `node replay/idle-ab.mjs --duck db/a.duckdb --sqlite db/d.sqlite --day 20261117 --code KOTA --day-codes … --to 10:00`, run twice | 08:55–10:00 data | idle | 2 × 96 s |

Each `ingest.err` and `feeder.err` is empty. Every read returned rows except those that fall before the first flush. The DuckDB and SQLite runs over 08:55–10:00 (a and d) stored identical row counts in every table. The feeder used 0.016 cores, so it never limited a run.

## CPU and memory

Per-second samples from `ingest.mjs` (`process.cpuUsage`, `/proc/stat`, RSS, `duckdb_memory()`).

| | a: 1x, 1 h | b: 5x, whole day | c: 5x, 3 stages | d: SQLite 5x | e: 5x, with kill |
| --- | --- | --- | --- | --- | --- |
| Ingest CPU, cores p50 / p99 / max | 0.24 / 0.60 / 0.99 | 0.27 / 0.79 / 1.85 | 0.22 / 0.81 / 0.95 | 0.05 / 0.31 / 0.43 | 0.24 / 0.81 / 1.20 |
| Box CPU, cores of 2, p50 / p99 / max | 0.40 / 1.50 / 1.92 | 0.44 / 1.55 / 2.00 | 0.38 / 1.46 / 1.73 | 0.20 / 1.37 / 1.55 | 0.43 / 1.53 / 1.78 |
| Ingest RSS MiB p50 / max | 564 / 804 | 759 / 1,178 | 626 / 845 | 265 / 307 | 522 / 748 |
| DuckDB buffer memory MiB p50 / max | 73 / 125 | 246 / 626 | 164 / 298 (all 3) | – | 71 / 138 |
| JS heap MiB max | – | 243 | 115 | 108 | 184 |
| MemAvailable, lowest MiB | 2,621 | 2,450 | 2,855 | 3,245 | 2,982 |
| Event-loop delay max per s, p99 ms | 91 | 108 | 121 | 243 | 148 |

The containers, from `docker stats` during b (173 samples): Firecrawl's API held 1.6 GiB and RabbitMQ 319 MiB. RabbitMQ's CPU stayed near 0.8% at p50 and spiked to 74% at p95 and 145% at max. Those spikes are most of the box's p99. Multica runs outside Docker, and its Node processes were idle. The ingest's own CPU is a third of one core at 5x, so CPU is not the limiter.

DuckDB's buffer memory grows with the day (626 MiB by the close in b) under the 1,500 MB cap. RSS stays about 500 MiB above it, which is the Node heap, the fold and the native client. Three stages, each fed the whole Production stream, added about 100 MiB of RSS over one stage for the same minutes. That overstates Staging and previews, which carry far less traffic.

## Flush, checkpoint and lag

From the `flush` lines. `blocked` is the time the event loop could not run: JSON encoding, gzip of the book chunks and the synchronous Appender. `commit` includes any automatic checkpoint.

| | a: 1x | b: whole day 5x | e: 5x with kill | d: SQLite 5x |
| --- | --- | --- | --- | --- |
| Flushes | 65 | 455 | 65 | 65 |
| Rows per flush p50 / max | 8,274 / 27,207 | 4,632 / 29,130 | 8,274 / 27,206 | same as a |
| Flush total ms p50 / p99 / max | 209 / 802 / 802 | 173 / 1,054 / 4,343 | 184 / 935 / 935 | 165 / 324 / 324 |
| Event loop blocked ms p50 / max | 74 / 130 | 57 / 125 | 73 / 232 | 165 / 324 (all of it) |
| Commit ms without checkpoint p50 / max | – | 14 / 103 | 17 / 118 | 78 / 163 |
| Automatic checkpoints | 9 | 50 | 8 | none (WAL) |
| Commit ms with checkpoint p50 / max | 188 / 633 | 247 / 4,083 | 271 / 784 | – |
| Final `CHECKPOINT` ms | 76 | 217 | 124 | 19 (`wal_checkpoint`) |
| Receipt to commit, p50 of each flush's median (ms) | 35,391 | 7,057 | 7,273 | 7,215 |
| Receipt to commit, worst trade (ms) | 65,557 | 17,336 | 13,897 | 13,278 |
| Commit to visible to another connection, p50 / max ms | 46 / 107 | 40 / 110 | 37 / 92 | 7 / 26 |

At 5x, a replay minute lasts 12 s of wall time, so the 5x lags are a fifth of the real-speed ones. Run a gives the real-speed lag. The slowest checkpoint commits in b, all in the second half of the day:

| Flush (WIB) | Commit ms | WAL before | Trades in flush |
| --- | --- | --- | --- |
| 13:31 | 4,083 | 9 MB | 19,645 |
| 12:37 | 2,707 | 15 MB | 0 |
| 10:43 | 1,632 | 11 MB | 2,644 |
| 14:59 | 1,167 | 12 MB | 2,803 |

The 12:37 flush wrote no trades and still took 2.7 s, so the checkpoint's cost follows the size of the stored tables (it rewrites row groups that `INSERT OR REPLACE` touched), not the size of the flush. Of b's 32,418 load reads, 144 took over 250 ms and 4 took over 1 s. Reads that overlapped a flush took 18 ms at p50 against 6 ms outside one for `newest200`, with a worst case of 3.7 s.

## Snapshot reads, DuckDB against SQLite

The six reads a viewer makes (`snapshotReads` in `stores.mjs`, written as `day-store.ts` writes them): the newest 200 trades, one code's candles, `tradesAt` with `highestWithin`'s binary search, the same with one `max(number)` statement, one code's book chunk gunzipped and parsed, and the 30 `storedCandlesOf` reads of one Select. Times are in ms.

**Idle**, from `idle-ab.mjs` on the same 08:55–10:00 data. The engines alternate in 10 blocks of 50 rounds each, at cutoffs from a fixed seed, so each engine reads the same cutoffs. Each figure is from 500 reads per engine per run. The two runs are shown as "run 1 · run 2".

| Read | DuckDB p50 | DuckDB p99 | SQLite p50 | SQLite p99 | DuckDB ÷ SQLite (p50) |
| --- | --- | --- | --- | --- | --- |
| newest 200 trades | 2.73 · 2.55 | 9.5 · 11.8 | 0.27 · 0.25 | 0.86 · 0.64 | 10x |
| one code's candles | 3.12 · 2.92 | 9.8 · 13.4 | 0.15 · 0.15 | 0.51 · 0.39 | 20x |
| `tradesAt`, binary search | 54.97 · 50.34 | 119 · 118 | 0.50 · 0.47 | 1.64 · 1.22 | 108x |
| `tradesAt`, one `max` | 9.52 · 9.13 | 27.4 · 27.5 | 8.59 · 8.00 | 33.0 · 27.5 | 1.1x |
| one code's book | 3.47 · 3.32 | 13.0 · 8.5 | 0.90 · 0.83 | 3.56 · 1.88 | 4x |
| 30 day-state reads | 92.8 · 86.3 | 169 · 182 | 3.87 · 3.71 | 9.4 · 6.1 | 24x |

**Under load**, from the in-process reader once a second, in the same 08:55–10:00 window at 5x (runs e and d), and over the whole day at 5x (run b):

| Read | DuckDB e p50 / p99 | DuckDB b, whole day, p50 / p99 | SQLite d p50 / p99 |
| --- | --- | --- | --- |
| newest 200 trades | 7.6 / 29.3 | 6.1 / 35.2 | 0.38 / 1.26 |
| one code's candles | 4.0 / 31.3 | 6.1 / 30.5 | 0.21 / 1.17 |
| `tradesAt`, binary search | 59.9 / 186 | 68.3 / 238 | 0.47 / 2.64 |
| `tradesAt`, one `max` | 7.7 / 36.7 | 9.9 / 38.7 | 6.6 / 22.7 |
| one code's book | 3.4 / 13.5 | 3.5 / 14.1 | 0.72 / 3.38 |
| 30 day-state reads | 86.8 / 306 | 91.7 / 286 | 2.2 / 8.9 |

The binary search issues about 17 point queries, and the day-state read issues 30. Divided per statement, both come to about 3 ms per DuckDB statement, close to the single-statement reads. The cost is per statement, not per row scanned, so it holds as the day grows: the binary search and day-state p50s over the whole day (b) are within 15% of the one-hour ones (e). SQLite's `tradesAt` with one `max` is slow too, because it scans `time`, which has no index. In SQLite, a read never overlaps a flush, because both run synchronously on the event loop. Instead, the flush blocks the event loop, including the reader, for 165 ms at p50 and 324 ms at most.

## Crash and restart

Run e, `kill-test.sh e 6 5`: wait for the 6th flush, wait 5 s more (replay 09:01:35 WIB, with 6,424 trades pending in memory), send `kill -9`, then start `restart.sh`. `compare.mjs db/a.duckdb db/e.duckdb 20261117` compares the result with run a, which covers the same window uninterrupted.

| Step | Time |
| --- | --- |
| `kill -9` to the process gone | 105 ms |
| `restart.sh` to the database open, Node start included | 257 ms |
| `DuckDBInstance.create` with WAL replay (`openMs`) | 128 ms, against 131 ms for a fresh file |
| Highest stored trade after reopen | 45,985, the last committed flush |
| Kill to the feeder reconnected and resuming | 0.5 s, with a burst of 7,976 trades |

| Table | Rows only in a | Same key, different value |
| --- | --- | --- |
| trades | 3 | 0 |
| candles, footprints | 0 | 2 each |
| book chunks | 0 | 462, all in the minute 09:01 |
| heatmaps | 0 | 0 |

Every committed row came back. The trades and candles that differ come from the feeder, not from the crash. The 3 missing trades and the 2 changed candles (BRIS and MDKA) all fall in the last 250 ms before 10:00. After a resume, the feeder's 250 ms tick grid is offset, so it never sent its last partial tick. The real loss is the book frames of the minute that was open at the kill: the relay sends a book frame once and never again, so all 462 of that minute's chunks hold only the frames from after the restart. Trades and candles recover because the resume resends every trade past the highest stored one. Pending trades numbered below that highest (late arrivals) would be lost the same way, but none occurred here. In Production, the backfill fills those gaps.

## Disk

| Database | File after final checkpoint | Contents |
| --- | --- | --- |
| DuckDB, whole day (b) | 415.5 MB (396 MiB in use, 1,468 of 1,585 blocks of 256 KiB) | 1,416,482 trades, 106,978 candles and footprints, 207,361 book chunks (124 MB of gzip) and heatmaps (395 MB of slice text) |
| DuckDB, 08:55–10:00 (a) | 106.2 MB | 456,837 trades, 27,809 book chunks |
| SQLite, 08:55–10:00 (d) | 180.4 MB | the same rows |
| DuckDB, 08:55–09:35, each of 3 stages (c) | 48 MB | |

A full day falls at the low end of the 0.3–1.5 GB estimate. For the same rows, SQLite's file is 1.7 times DuckDB's.

## Where the limiter is

- **Not CPU, not memory, not write throughput.** At 5x over the whole day, the ingest used under a core at p99, and 2.4 GiB of RAM stayed free. The busiest flush (29,130 rows) took 1 s, mostly checkpoint. Firecrawl's RabbitMQ spikes use more of the box than the ingest does.
- **Lag comes from the once-a-minute flush** (`FLUSH_PAST_MINUTE`): up to 65 s at real speed. DuckDB adds 40–110 ms on top. A shorter flush interval would cut this. The cost is more checkpoints, since a checkpoint follows the WAL's size.
- **Viewer reads are limited by DuckDB's cost per statement** (about 3 ms) and by **checkpoints inside the flush's commit**, which grow with the day to several seconds. Both were measured in process. Over Quack, each statement would also make an HTTP round trip.

## Open points

- **Reads through Quack or HTTP were not measured.** The prototype reads in process. Every per-statement cost above would gain a loopback round trip, which makes single-statement reads more important.
- **The decode is not the repo's.** `ingest.mjs` parses envelopes with `JSON.parse` and folds with its own code. It does not run the Effect decode, fold and `day-store.ts` from `apps/dashboard`. The flush's encode and fold CPU may differ.
- **Book frames are rebuilt.** The feeder samples each code's stored chunks across its minutes (`prep.mjs`, `feeder.mjs`), so book frame counts and sizes approximate the day. They are not the recorded frames.
- **One day, one load run per setup.** The idle A/B ran twice, and its p50s repeated within 10%. The load runs ran once each. Their DuckDB read p50s agree across a, b and e within 1.5x, which is far smaller than the 4–108x gap to SQLite.
- **No full-day SQLite run.** The disk ratio and the SQLite load numbers come from the first hour only.
- **The checkpoint was not tuned.** A higher `checkpoint_threshold`, or a manual `CHECKPOINT` from a separate connection after each flush or at lunch, could move the stall out of the viewer's path. The `--checkpoint-threshold` flag exists, but no run used it.
- **Several stages ran at full Production volume** (run c), which overstates them. 30 stored days and the growth of the ART index across days (open point 4) were not measured. Bun was not run.
- **The feeder's resume skips the last partial tick** of a window (above). Fix it before reusing `kill-test.sh` to count trade loss.
