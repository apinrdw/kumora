# DO SQL audit: which statements read and write the most rows

Research ticket [apinrdw/kumora#531](https://github.com/apinrdw/kumora/issues/531), part of the map [apinrdw/kumora#529](https://github.com/apinrdw/kumora/issues/529). Written 2026-11-18 against `origin/staging` at `b2dfa0e8bc`.

**Question.** On a full Production-size trading day, which statements of the trading-day and day-index Durable Objects read and write the most rows, and how many each day?

**Short answer.** One statement pair is responsible for most of the reads: the broker codes **status scan** (`broker-codes.ts:718` and `:724`, called through `status` at `:795`). It reads every stored trade of the day, once or twice. It runs after **every accepted broker codes batch on a sealed day**, through `totalsWritten`'s `buildable` (`trading-day.ts:1198`) or `completed`'s `codesComplete` (`sweep-brokers.ts:314`). It also runs on every extension status GET, and when some objects start. A busy day's evening walk sends about 800 Ajaib batches, and possibly 1,460 Stockbit batches. At 1.46 M to 2.92 M rows a scan, that comes to **0.6 B to 5.5 B rows read a day**, against the bill's ~3.7 B for each trading day. The cost runbook's model has no term for it. For writes, the largest writer that the runbook left out is the **broker trades index** (`broker-codes.ts:598`): two rows for each trade, 2.92 M a day. That is more than the tape itself (1.46 M). Together they account for most of the ~5.1 M rows written for each trading day on the bill.

## Sources and method

- Code read: `apps/dashboard/src/server/market-live/` (`day-store.ts`, `broker-codes.ts`, `sweep-brokers.ts`, `trading-day.ts`, `trading-day-object.ts`, `candles.ts`, `day-states.ts`, `recorded-answers.ts`, `order-flow-build.ts`, `wakes.ts`, `day-index.ts`, `durable-sql.ts`, `broker-totals.ts`), `apps/dashboard/src/server/broker-totals/{cron,reconcile,schedule}.ts`, and the extension's broker codes walks, `apps/extension/src/worker/broker-codes/{ajaib-walk,stockbit-walk,run-queue,extra-target}.ts` and `service-worker.ts`. Every frequency below cites the line that sets it. The `Decision:` comments these lines carry are quoted where they set the frequency.
- The model: `audit.mjs`, whose source is in [the last appendix](#appendix-the-scripts). It is kept in this doc, not as a file in the repo, so the repo's dead-code gate does not see it. It builds a day in Node 26's `node:sqlite` (SQLite 3.54.1) from the `SCHEMA` literals it reads out of `day-store.ts`, `broker-codes.ts`, `sweep-brokers.ts` and `day-index.ts`. The day holds 1.46 M trades with numbers in time order, 900 stocks and 10 indices × 300 minutes of candles (273 K), 270 K footprints, 30 codes × 273 minutes of book chunks and heatmaps, 1,460 broker code chunks, 150 K sweep brokers rows and 910 live prices. For each statement, the script prints its `EXPLAIN QUERY PLAN`, the rows it returns, the rows its plan visits, and SQLite's own `vmStep` and `fullscanStep` counters (`StatementSync.stat`, which is `sqlite3_stmt_status`). It also simulates the composite reads: `highestWithin`, a minute read, the status scan, the broker totals build, and a live day's restart. `table.mjs` (same appendix) prints its JSON as the statement table. To rerun, save both scripts outside the repo, then run from the repo root: `node <dir>/audit.mjs <db> --rebuild [--no-gaps] > out.json`, then `node <dir>/table.mjs out.json`. The build takes about 3 s, and the database is about 500 MB.
- **Rows visited** comes from the plan: a SCAN visits the whole table, a SEARCH visits the rows in its range, and a correlated subquery runs once for each outer row. Node has no `rowsRead`. Cloudflare documents `rowsRead` as the rows a query scanned, and `durable-sql.ts` adds up each cursor's figure. `vmStep` cross-checks the estimate: a statement whose plan claims a small range never shows millions of steps. One exception: a bare `SELECT count(*) FROM t` runs as SQLite's `OP_Count` (vmStep 9) and steps no row. Whether Cloudflare bills that as the table's size is **unconfirmed**. It runs once a day (`storedTrades` at the seal), so the answer changes nothing here.
- **Gaps.** The status scan's cost depends on whether each 64-chunk page of trade numbers holds the tape whole. When the `count(*)` (`:718`) falls short of the page's span, the `lag()` run query (`:724`) reads the same range again. The script runs both cases: `--no-gaps` (every number stored), and the default, with a 30-number relay gap every 10,000 trades (0.3 % missing, all of it filled by walk rows).

## The composite reads, measured

| What                                                                                          |                Statements |        Rows visited | Basis                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ------------------------: | ------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `highestWithin` (`day-store.ts:625`), one call                                                |                        23 |                  23 | 2 bound reads + 21 `firstFrom` steps (log₂ 1.46 M), 1 row each                                                                                                                                                   |
| A minute read, `tradesBetween` / `minuteTrades` (`:672`, `:859`)                              |                        46 |               4,993 | two searches, then the minute's range: 4,867 trades at the mean minute, about 30 K at the peak (runbook)                                                                                                         |
| A `tradesAt` (`:648`), tape or codes GET                                                      |                        24 |                ~223 | one search, then 200 rows plus the skew's few                                                                                                                                                                    |
| **Status scan** (`broker-codes.ts:752` `scan` + `:795`), day whole                            | 70 (no gaps) / 116 (gaps) | **1.46 M / 2.92 M** | 23 chunk pages; each page counts its 64 K trade numbers, and with a gap reads them again with `lag()`                                                                                                            |
| Status scan, half the chunks held (top half, as Ajaib's newest-first walk leaves it)          |                   37 / 61 |     0.73 M / 1.46 M | same, over the held span                                                                                                                                                                                         |
| Broker totals build's reads (`broker-totals.ts:93` → `heldTradesPage`, `broker-codes.ts:892`) |                        47 |              2.92 M | `FIELDS_BETWEEN` reads the trades range twice (the UNION and its `NOT IN` list)                                                                                                                                  |
| Live day restart (`trading-day.ts:478`–`538`)                                                 |                    ~1,000 |              1.42 M | `storedBubbles` 1.08 M (both queries: SEARCH candles for each code, plus SCAN footprints for the `IN` list), `eachStoredSweeps` 270 K in 540 pages, `newestTrades` 10 K, frame minutes 45 K, `latestChunks` 16 K |

The restart's frame minutes term is a guess. Each distinct minute among the codes' last `liveprice` frames costs a minute read (`trading-day.ts:291`). The model's Zipf day puts every code's last frame in 9 minutes. A real day whose illiquid codes last traded early in the day spreads those frames over up to ~300 minutes, which approaches one read of the whole tape (+1.46 M). Each restart therefore reads 1.4 M to 2.9 M rows.

## Rows read a day, ranked

A Production relay day at the busiest measured volume (1.46 M trades). _S_ is one whole status scan: 1.46 M rows without gaps, 2.92 M with them. Every **guess** is marked, and the last column names the figure that would confirm it.

|   # | Statement (call site)                                                                                                                                              | Trigger                                                                                                                                                       | Runs a day                                                                                                                                                                                                                  | Rows a run                                                                                                   | Rows a day         | Basis, and what confirms a guess                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Status scan (`broker-codes.ts:718` + `:724`, via `trading-day.ts:1198` `totalsWritten` → `buildable`, or `sweep-brokers.ts:314` `completed` → `codesComplete`)     | each accepted Ajaib batch on the sealed day                                                                                                                   | ~820 batches (**guess**: the 2026-11-12 probe walked 1..1,500,490 in 820 calls, `ajaib-walk.ts:36`; one batch a page that kept rows, `:385`)                                                                                | S/2 on average: the walk goes newest first, so the held span grows from 0 to the whole day                   | **0.6 B – 1.2 B**  | Both callers scan after every batch until the day is buildable _and_ its codes are complete. `buildable` scans whenever the fact is not the build version and no build wake is set. `completed` scans whenever `keptCodesComplete` was reset by the batch (`broker-codes.ts:647`) and `storageLogged` is false for this instance. Confirm with the count of `POST /broker-codes` a day per stage, and the namespace's rows read by hour (the spike should sit at 17:00–19:00 WIB).                                                                    |
|   2 | Same status scan                                                                                                                                                   | each accepted Stockbit cross-check batch                                                                                                                      | 0, or up to ~1,460 (**guess**: 1,000 trades a batch, `stockbit-walk.ts:37`)                                                                                                                                                 | S (it walks forward from trade 1 over a day already held)                                                    | **0 – 4.3 B**      | **The swing term.** If Ajaib's walk left every trade 1..N with codes, the first `completed` after it logs and sets `storageLogged`, and Stockbit's non-correcting batches return early. If any trade is still missing codes, every Stockbit batch scans the whole day until it fills the last one. The same applies to a Stockbit walk of a sealed day that Ajaib did not serve (`window-passed`), at S/2 on average. Confirm with the time of the day's `Order flow storage` line (logged at the first complete scan) against the walk's last batch. |
|   3 | Status scan, through the status GET (`broker-codes.ts:930` `statusAnswer`), plus the start scan of a sealed, unbuilt day (`trading-day.ts:375` `buildWakeAtStart`) | the extension's runs: `recentIncomplete` asks 10 days (`run-queue.ts:187`, `RECENT_DAYS = 10`), and each walk asks its day once                               | ~12 GETs a run × R runs (**guess**: R = 3–20). A run starts on every broker tab `connect` (`service-worker.ts:555`), settings change, Resume, and the first tick on a new day. A tab that reloads or reconnects starts one. | S of that day, ×2 when the object starts on a sealed day whose broker totals fact is unset (never buildable) | **0.05 B – 0.7 B** | Confirm with the count of `GET /broker-codes` status a day per stage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|   4 | Minute read (`day-store.ts:682`, via `storedMinuteTrades`, `candles.ts:410` and `:696`)                                                                            | a late trade in a stored minute (`readBack`), and an alerting sweep whose trades left the book                                                                | 1 K – 10 K (**guess**: the runbook's)                                                                                                                                                                                       | 46 statements + 5 K – 30 K                                                                                   | 5 M – 300 M        | `billedMinuteRereadRows` in the `Rows written` lines measures it already.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|   5 | Sweep brokers recompute (`sweep-brokers.ts:236` minute read, `:217` `storedText` for each code-minute, `day-store.ts:871` `minutesOfTrades`)                       | each batch that changed codes                                                                                                                                 | ~820 (Ajaib), few from Stockbit                                                                                                                                                                                             | 10 K – 35 K                                                                                                  | 8 M – 29 M         | `billedSweepBrokerReadRows` measures it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|   6 | Live day restart (`trading-day.ts:478`–`538`: `storedBubbles` `day-store.ts:745`/`:756`, `eachStoredSweeps` `:986`, `newestTrades` `:603`, frame minutes `:682`)   | each start of today's object, which also restores after the seal until midnight (`restoring = !sealed \|\| today`, `trading-day.ts:460`)                      | 2 – 20 (**guess**: deploys, evictions after an idle gap while it holds no viewer and no relay socket, `blockConcurrencyWhile` resets)                                                                                       | 1.4 M – 2.9 M                                                                                                | 3 M – 58 M         | There is no start log line. Confirm with the namespace's requests against its wall-time gaps, or with a start log.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|   7 | Writing a batch's fields (`broker-codes.ts:567`)                                                                                                                   | each batch with fields                                                                                                                                        | ~820 + ~1,460                                                                                                                                                                                                               | ~10 K (Ajaib), ~2 K (Stockbit)                                                                               | ~11 M              | json_each, plus a range read of the tape's numbers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
|   8 | Broker totals build (`broker-codes.ts:892` + a scan at `trading-day.ts:1155`)                                                                                      | the build wake, and every stale rebuild 5 min after a correcting batch (`REBUILD_QUIET`)                                                                      | 1 – 3 (**guess**)                                                                                                                                                                                                           | 2.92 M + S                                                                                                   | 4 M – 18 M         | The `Broker totals built` lines count the builds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|   9 | Reconcile poke (`trading-day.ts:1212` `reconcile` → `buildable`, plus the start scan at `:375`)                                                                    | the 11:00 UTC cron (`schedule.ts`), for every listed day that is unbuilt or older. An unbuildable day answers 204 and takes no slot, so it is poked every day | U unbuildable days (**guess**: 0–10)                                                                                                                                                                                        | 2 S                                                                                                          | 0 – 58 M           | The `Broker totals reconciled` line's `pokedDays` minus `buildingDays`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|  10 | Play: `tradesAt` for the Tape and BrokerCodes GETs (`recorded-answers.ts:102`, `:111`)                                                                             | 4 GETs a second each while Play runs (`TAPE_INTERVAL_MS = 250`)                                                                                               | **guess**: 0–3 h of Play                                                                                                                                                                                                    | ~223 each                                                                                                    | 0 – 20 M           | ~6.5 M an hour of Play                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|  11 | `hasTrade` (`day-store.ts:573`)                                                                                                                                    | each copy, from the lagging feed or a backfill page, of a trade below the tape                                                                                | ≤ 1.46 M                                                                                                                                                                                                                    | 1                                                                                                            | ≤ 1.5 M            | Stockbit runs ~17 min behind Ajaib (Decision above `insertRelayed`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|  12 | `slotOf`'s three key reads (`candles.ts:382`–`388`)                                                                                                                | each new (code, minute) slot                                                                                                                                  | ~300 K – 400 K                                                                                                                                                                                                              | 3                                                                                                            | ~1 M               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|  13 | Snapshot on a viewer's Select (`trading-day.ts:1367`: `storedCandlesOf` `:713` + `storedFootprintsOf` `:805`)                                                      | each Select                                                                                                                                                   | **guess**: 500 – 2,000                                                                                                                                                                                                      | ~600                                                                                                         | ≤ 1.2 M            | Also today's recorded Candles, Sweeps and Heatmap GETs, at ~300–600 rows each                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|  14 | Seal reads (`storedTrades` `:597`, `orderFlowStorage` `:925`/`:928`, sweep storage `sweep-brokers.ts:291`)                                                         | once, plus once more at the first complete scan                                                                                                               | 1 – 2                                                                                                                                                                                                                       | 1.46 M (if billed) + 428 K                                                                                   | ≤ 2.3 M            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The day-index object reads its whole `days` table (`day-index.ts:42`, about 40 rows) on every day strip GET and every reconcile run, and writes one row at each seal. That is negligible.

Statements that do **not** cost what the ticket asked about:

- **Schema statements at a start.** `CREATE TABLE IF NOT EXISTS` ×13, `PRAGMA table_info` (14 rows) and the start's ~15 fact reads cost a few dozen rows a start.
- **The `ADDED_CANDLE_COLUMNS` / `REBUILD_CANDLE_SIDES` migration** (`day-store.ts:349`–`356`) does not run on every wake. It runs only when `PRAGMA table_info(candles)` lacks `buy_value` or `sell_value`. The `ALTER` adds the columns in the same transaction, so each pre-#436 day pays it once, at its first start: 1.73 M rows visited and about 1.1 s on a full day. A day created since then has both columns from `SCHEMA`, so it never runs.
- **`latestChunks`** (`:1070`) is a correlated subquery, but it visits only 16 K rows at a restart.
- **`eachStoredSweeps`** (`:986`) seeks on the key: its `(code, minute) > (?, ?)` plan is `SEARCH footprints USING PRIMARY KEY ((code,minute)>(?,?))`. Its 540 pages visit 270 K rows in all.
- **`orderFlowMinutes`** (`:846`) reads the 8 K book chunks grouped by code, once a build.
- **The flush itself** (`trading-day.ts:774`, ~470 a day: one a minute while something is unwritten, 5 s past the minute, `armFlush`) reads only a couple of facts (`sweepBrokers.persisting`). Its cost is all writes.
- **The Day state fallback** (`day-states.ts:402` → `storedCandlesOf`) reads only while Stockbit is not live, for each changed watched code a delta (every 250 ms). Each read covers the minutes after that code's last `liveprice`. That can reach ~300 rows a code-delta during a long Stockbit outage. It is zero on a normal day.

## Rows written a day, ranked

|   # | Statement (call site)                                            | Trigger                                                                                            | Runs a day            | Rows a run | Rows a day                                                        | Basis                                                                                     |
| --: | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------- | ---------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
|   1 | Broker trades index insert (`broker-codes.ts:598`)               | each trade side whose codes a batch changed (`indexMoves`, `:478`), so both sides on first arrival | 2 × 1.46 M            | 1          | **2.92 M**                                                        | Not in the runbook's model. A side whose codes change later also costs a delete (`:593`). |
|   2 | Trade insert (`day-store.ts:464`)                                | each settled trade, at its flush                                                                   | 1.46 M                | 1          | **1.46 M**                                                        | INTEGER PRIMARY KEY, no index (the Decision on `SCHEMA`)                                  |
|   3 | Live price replace (`day-store.ts:478`)                          | each code whose regular-board frame changed since the last flush                                   | ≤ 910 × ~470 flushes  | 1          | ≤ 0.43 M (**guess**: most codes change each minute while trading) | Read as `livePrices` in the `Rows written` lines                                          |
|   4 | Candle replace (`day-store.ts:437`)                              | each candle whose settled figures changed                                                          | 270 K × r             | 1          | 0.4 M (0.54 M upper)                                              | runbook: P 270 K upper, r 1.5–2                                                           |
|   5 | Footprint replace (`day-store.ts:415`)                           | each regrouped stock-minute                                                                        | as candles            | 1          | 0.4 M (0.54 M upper)                                              | runbook                                                                                   |
|   6 | Sweep brokers replace or delete (`sweep-brokers.ts:266`, `:260`) | rows that a batch's recompute changed                                                              | P_sb × r_sb           | 1          | 0.2 M (0.54 M upper)                                              | runbook's sweep brokers estimate                                                          |
|   7 | Ajaib book replace (`day-store.ts:495`)                          | each code whose Ajaib book changed since the last flush                                            | K × ~470              | 1          | 14 K – 47 K                                                       | K = 30–100 codes with books                                                               |
|   8 | Book chunk + heatmap (`day-store.ts:487`, `:428`)                | each code-minute with a book, once                                                                 | 2 × 8.2 K             | 1          | 16 K                                                              | runbook: K 30 × 273                                                                       |
|   9 | Broker code chunk replace (`broker-codes.ts:587`)                | every chunk a batch touched, changed or not                                                        | ~820 × 6 + ~1,460 × 2 | 1          | ~8 K                                                              |                                                                                           |
|  10 | Facts (`day-store.ts:455`, `broker-codes.ts:612`, wakes `:542`)  | each flush (feed downs, the sweep brokers progress) and each batch (N, cross-check)                | ~3 K – 5 K            | 1          | ~5 K                                                              |                                                                                           |
|  11 | Walk fields (`broker-codes.ts:567`)                              | the trades the tape lacks                                                                          | ~4 K                  | 1          | ~4 K                                                              | 0.3 % gaps                                                                                |

Sum: about **5.9 M rows written** on a 1.46 M-trade day. The broker trades index is half of it, and the tape a quarter.

Two caveats:

- **Replaced rows.** If Cloudflare bills a replaced row (`INSERT OR REPLACE` over an existing key) as a delete plus an insert, rows 3–7 count double, about +1.0 M a day. The runbook's ratio `ΣbilledRowsWritten / Σ(all row fields)` from a Staging day settles it. The `Rows written` meter's fields omit broker codes, so their writes appear only in `billedRowsWritten` on the post-seal lines.
- **One-off writes.** The broker trades index rebuild (`broker-codes.ts:986`, 2 rows a trade), the order flow build (`order-flow-build.ts`) and the sweep brokers build each run once for an old day. They add about one day's writes of their tables for each day built.

## Against the bill

The bill for the period, 2026-11-01 to 2026-11-18, shows 43.9 B rows read and 61.53 M rows written, over about 12 trading days. That is about **3.7 B read and 5.1 M written per trading day**.

- **Writes fit.** The model gives 5.9 M on the busiest day. An average day (about 1.1–1.2 M trades) gives about 4.5–5 M, so 12 days come to 54–60 M. The rest fits Staging, if it was fed (see below), or replaced rows billing double. The runbook's model priced the tape (~32 M a month) and the order flow tables. It did not price the broker trades index, which is the largest single writer.
- **Reads fit only through the status scan.** Terms 4–14 together reach at most ~0.5 B a day, even at their upper guesses, and most days sit near 50 M. Term 1, the Ajaib evening, alone gives 0.6–1.2 B a day, or 7–14 B over the period. Reaching 43.9 B needs one or more of these:
  - Stockbit batches that each scanned a whole day (term 2: up to 4.3 B a day, so ~50 B over 12 days at most).
  - Many extension runs (term 3).
  - Full Stockbit or gap walks of older sealed days. Each accepted batch on any sealed day scans that day.
  - A second stage scanning the same batches.

  The runbook's line for these reads was "about 300 Ajaib batches a day × up to 30 K rows". It counted the sweep brokers recompute and missed the status scan that `totalsWritten` and `completed` run after each batch.

- **The guesses that move the total most, in order:**
  1. How many accepted batches a day land on a sealed day whose codes are not yet complete. Most important: whether Stockbit's cross-check batches scan, that is, whether Ajaib leaves 1..N complete.
  2. How many extension runs a day, and so status GETs, each stage gets.
  3. Whether the per-page `count(*)` usually falls short (S = 2.92 M) or matches (1.46 M). This depends on whether the relay misses a number in most 64 K spans.
  4. How many evening walks of older sealed days run (gap walks, catch-ups, a Stockbit walk after `window-passed`).

  Rows read by hour for the `TradingDay` namespace on each stage, and the count of `POST /broker-codes` and status GETs a day per stage, would settle items 1 and 2. A per-statement meter on the status scan (rows read a scan, logged) would settle item 3 in one evening. Ticket #530's per-stage split is where those figures belong.

## Staging and preview stages

- **The broker codes extra target.** The extension tees every Production batch to an extra target (Staging, a Preview or a Dev stage) through a lane of 16 (`extra-target.ts:26`, `tee`). It also runs that target's catch-up walks and status GETs. A Staging day that also received the relay (its own ingest target, `target.ts`) behaves as Production does: the same per-batch scans and the same writes. A Staging day without a tape becomes a **walk day** (`walkTapeOf`, `trading-day.ts:945`). Each batch's fields then become its tape: 1.46 M trade writes plus 2.92 M index writes. Once N is known, each batch before its seal runs `walkSealDue` → `buildable` (`trading-day.ts:1138`), a scan. Its seal builds the order flow rows from the tape (`buildWalkedDay`), which reads the whole tape a minute at a time and writes the candles and footprints.
- **The ingest extra target.** A stage that gets relayed frames all day pays the flush writes (≈ 2.9 M a day without broker codes), the restarts and the late-trade re-reads, as Production does.
- **The reconcile cron runs on every stage** (`stage-crons.ts`, Decision on `RECONCILE_CRON`). Each stage's unbuildable days are poked, and scanned twice, every day.
- **e2e runs and previews** create small days (seconds of frames, a few batches). Their rows are negligible unless a preview receives the extension's extra target. Each preview stage has its own `TradingDay` namespace, so its usage shows apart in a per-namespace split.

## Appendix: every statement on the model day (gaps case)

These are the plans and counts from `audit.mjs` on the default (gaps) day. The no-gaps day has the same plans. Its status scan is 1.46 M rows in 70 statements (the `lag()` read never runs), and its broker totals build is 2.92 M. Writes run inside a savepoint that is rolled back. Their row is the plan's single key write; SQLite shows no plan for a plain `INSERT`.

| Site                   | Statement                             | Plan                                                                                                                                                                                                                                                                   | Rows visited | Rows returned |     vmStep |    ms |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: | ------------: | ---------: | ----: |
| `day-store.ts:342`     | schema (8 CREATE TABLE IF NOT EXISTS) | (write or pragma)                                                                                                                                                                                                                                                      |            0 |             0 |          5 |     0 |
| `day-store.ts:344`     | PRAGMA table_info(candles)            | (write or pragma)                                                                                                                                                                                                                                                      |           14 |            14 |        103 |     0 |
| `day-store.ts:348`     | sealed fact                           | SEARCH facts USING PRIMARY KEY (key=?)                                                                                                                                                                                                                                 |            1 |             1 |         11 |     0 |
| `day-store.ts:355`     | REBUILD_CANDLE_SIDES (old day only)   | MATERIALIZE sides; SCAN trades; USE TEMP B-TREE FOR GROUP BY; SCAN sides; SEARCH candles USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                       |    1,728,620 |             0 | 70,191,395 |  1111 |
| `day-store.ts:415`     | footprint row                         | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         28 |   0.1 |
| `day-store.ts:428`     | heatmap row                           | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         22 |   0.1 |
| `day-store.ts:437`     | candle row                            | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         69 |     0 |
| `day-store.ts:455`     | fact row                              | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         19 |     0 |
| `day-store.ts:464`     | trade row                             | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         26 |     0 |
| `day-store.ts:478`     | live price row                        | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         19 |     0 |
| `day-store.ts:487`     | book chunk row                        | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         22 |     0 |
| `day-store.ts:495`     | Ajaib book row                        | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         19 |     0 |
| `day-store.ts:542`     | fact delete                           | SEARCH facts USING PRIMARY KEY (key=?)                                                                                                                                                                                                                                 |            1 |             0 |         10 |     0 |
| `day-store.ts:573`     | hasTrade                              | SEARCH trades USING INTEGER PRIMARY KEY (rowid=?)                                                                                                                                                                                                                      |            1 |             1 |          9 |     0 |
| `day-store.ts:582`     | boundTrade min                        | SEARCH trades                                                                                                                                                                                                                                                          |            1 |             1 |         14 |     0 |
| `day-store.ts:582`     | boundTrade max                        | SEARCH trades                                                                                                                                                                                                                                                          |            1 |             1 |         14 |     0 |
| `day-store.ts:597`     | storedTrades count(*)                 | SCAN trades                                                                                                                                                                                                                                                            |    1,455,620 |             1 |          9 |  12.3 |
| `day-store.ts:603`     | newestTrades (TAPE_LIMIT 10,000)      | SCAN trades                                                                                                                                                                                                                                                            |       10,000 |        10,000 |    130,009 |    12 |
| `day-store.ts:613`     | firstFrom (one binary search step)    | SEARCH trades USING INTEGER PRIMARY KEY (rowid>?)                                                                                                                                                                                                                      |            1 |             1 |         13 |     0 |
| `day-store.ts:657`     | tradesAt final read (200)             | SEARCH trades USING INTEGER PRIMARY KEY (rowid<?)                                                                                                                                                                                                                      |          200 |           200 |      3,011 |   0.2 |
| `day-store.ts:682`     | tradesBetween range (one minute)      | SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)                                                                                                                                                                                                          |        4,948 |         4,867 |     88,186 |   3.8 |
| `day-store.ts:698`     | storedCandle                          | SEARCH candles USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                                                                                                 |            1 |             1 |         35 |     0 |
| `day-store.ts:713`     | storedCandlesOf (whole code)          | SEARCH candles USING PRIMARY KEY (code=? AND minute>?)                                                                                                                                                                                                                 |          300 |           300 |      7,813 |   0.4 |
| `day-store.ts:745`     | storedBubbles day sums                | SEARCH candles USING PRIMARY KEY (code=?); LIST SUBQUERY 1; SCAN footprints                                                                                                                                                                                            |      540,000 |           900 |  7,591,537 |    60 |
| `day-store.ts:756`     | storedBubbles newest minutes          | CO-ROUTINE (subquery-2); CO-ROUTINE (subquery-4); SEARCH candles USING PRIMARY KEY (code=?); LIST SUBQUERY 1; SCAN footprints; USE TEMP B-TREE FOR LAST TERM OF ORDER BY; SCAN (subquery-4); SCAN (subquery-2)                                                         |      540,000 |        54,900 | 24,668,146 | 273.7 |
| `day-store.ts:778`     | candlesOf                             | SEARCH candles USING PRIMARY KEY (code=?)                                                                                                                                                                                                                              |          300 |           300 |      7,810 |   0.6 |
| `day-store.ts:791`     | storedFootprint                       | SEARCH footprints USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                                                                                              |            1 |             1 |         13 |     0 |
| `day-store.ts:805`     | storedFootprintsOf                    | SEARCH footprints USING PRIMARY KEY (code=?)                                                                                                                                                                                                                           |          300 |           300 |      1,510 |   0.2 |
| `day-store.ts:839`     | orderFlowMinutes trade time           | SEARCH trades USING INTEGER PRIMARY KEY (rowid=?)                                                                                                                                                                                                                      |            1 |             1 |          9 |     0 |
| `day-store.ts:846`     | orderFlowMinutes chunk span           | SCAN book_chunks                                                                                                                                                                                                                                                       |        8,190 |            30 |    106,908 |   1.4 |
| `day-store.ts:871`     | minutesOfTrades                       | SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)                                                                                                                                                                                                          |        5,001 |             1 |     45,015 |   0.3 |
| `day-store.ts:892`     | chunkOfMinute                         | SEARCH book_chunks USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                                                                                             |            1 |             1 |         13 |     0 |
| `day-store.ts:902`     | storedNothing chunk                   | SCAN book_chunks                                                                                                                                                                                                                                                       |            1 |             1 |         10 |     0 |
| `day-store.ts:925`     | orderFlowStorage footprints           | SCAN footprints                                                                                                                                                                                                                                                        |      270,000 |             1 |  2,160,013 |  38.5 |
| `day-store.ts:928`     | orderFlowStorage heatmaps             | SCAN heatmaps                                                                                                                                                                                                                                                          |        8,190 |             1 |     40,963 |  13.7 |
| `day-store.ts:947`     | storedSweeps                          | SEARCH footprints USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                                                                                              |            1 |             1 |         14 |     0 |
| `day-store.ts:963`     | storedSweepsOf                        | SEARCH footprints USING PRIMARY KEY (code=?)                                                                                                                                                                                                                           |          300 |           300 |      1,510 |   0.1 |
| `day-store.ts:986`     | eachStoredSweeps page (500)           | SEARCH footprints USING PRIMARY KEY ((code,minute)>(?,?))                                                                                                                                                                                                              |          500 |           500 |      5,471 |   0.2 |
| `day-store.ts:1016`    | livePrices                            | SCAN live_prices                                                                                                                                                                                                                                                       |          910 |           910 |      2,736 |   0.2 |
| `day-store.ts:1023`    | livePrice                             | SEARCH live_prices USING PRIMARY KEY (code=?)                                                                                                                                                                                                                          |            1 |             1 |         11 |     0 |
| `day-store.ts:1036`    | chunkAt                               | SEARCH book_chunks USING PRIMARY KEY (code=? AND minute<?)                                                                                                                                                                                                             |            1 |             1 |         17 |     0 |
| `day-store.ts:1049`    | heatmapOf                             | SEARCH heatmaps USING PRIMARY KEY (code=?)                                                                                                                                                                                                                             |          273 |           273 |      1,375 |   0.5 |
| `day-store.ts:1070`    | latestChunks                          | SCAN b; CORRELATED SCALAR SUBQUERY 1; SEARCH book_chunks USING PRIMARY KEY (code=?)                                                                                                                                                                                    |       16,380 |            30 |    147,486 |  39.4 |
| `day-store.ts:1081`    | ajaibBooks                            | SCAN ajaib_books                                                                                                                                                                                                                                                       |          900 |           900 |      3,606 |     1 |
| `day-store.ts:1090`    | fact                                  | SEARCH facts USING PRIMARY KEY (key=?)                                                                                                                                                                                                                                 |            1 |             1 |         11 |     0 |
| `broker-codes.ts:415`  | chunkOf                               | SEARCH broker_code_chunks USING INTEGER PRIMARY KEY (rowid=?)                                                                                                                                                                                                          |            1 |             1 |          9 |     0 |
| `broker-codes.ts:461`  | recordedOf                            | SEARCH cross_check_differences USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)                                                                                                                                                                                         |            1 |             1 |         16 |     0 |
| `broker-codes.ts:567`  | writeFields (5,000 rows)              | SCAN row VIRTUAL TABLE INDEX 1:; LIST SUBQUERY 1; SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?); CREATE BLOOM FILTER                                                                                                                                   |       10,000 |             0 |     95,033 |   2.7 |
| `broker-codes.ts:587`  | chunk replace                         | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         15 |   0.1 |
| `broker-codes.ts:593`  | index row delete                      | SEARCH broker_trades USING PRIMARY KEY (broker=? AND investor_type=? AND side=? AND number=?)                                                                                                                                                                          |            1 |             0 |         21 |     0 |
| `broker-codes.ts:598`  | index row insert                      | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         24 |     0 |
| `broker-codes.ts:603`  | difference replace                    | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         17 |     0 |
| `broker-codes.ts:610`  | difference delete                     | SEARCH cross_check_differences USING INTEGER PRIMARY KEY (rowid=?)                                                                                                                                                                                                     |            1 |             0 |          8 |     0 |
| `broker-codes.ts:718`  | status: taped count (64 chunks)       | SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)                                                                                                                                                                                                          |       63,820 |             1 |    255,294 |   1.4 |
| `broker-codes.ts:724`  | status: tape runs (lag)               | CO-ROUTINE (subquery-1); CO-ROUTINE (subquery-3); SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?); SCAN (subquery-3); SCAN (subquery-1)                                                                                                                  |       63,820 |             6 |  2,744,324 |  30.9 |
| `broker-codes.ts:734`  | status: tape high                     | SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)                                                                                                                                                                                                          |            1 |             1 |         18 |     0 |
| `broker-codes.ts:741`  | status: walk rows                     | SEARCH walk_trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)                                                                                                                                                                                                     |          180 |           180 |        910 |     0 |
| `broker-codes.ts:757`  | status: chunk page (64)               | SEARCH broker_code_chunks USING INTEGER PRIMARY KEY (rowid>?)                                                                                                                                                                                                          |           64 |            64 |        330 |   0.2 |
| `broker-codes.ts:817`  | status: differences count(*)          | SCAN cross_check_differences                                                                                                                                                                                                                                           |        1,000 |             1 |          9 |     0 |
| `broker-codes.ts:892`  | heldTradesPage FIELDS_BETWEEN         | MERGE (UNION ALL); LEFT; SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?); RIGHT; SEARCH walk_trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?); LIST SUBQUERY 2; SEARCH trades USING INTEGER PRIMARY KEY (rowid>? AND rowid<?); CREATE BLOOM FILTER |      127,820 |        64,000 |  1,582,449 |  41.7 |
| `broker-codes.ts:942`  | holdsNone / indexBuilt                | SCAN broker_code_chunks                                                                                                                                                                                                                                                |            1 |             1 |         10 |     0 |
| `sweep-brokers.ts:217` | storedText                            | SEARCH sweep_brokers USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                                                                                           |            1 |             1 |         13 |     0 |
| `sweep-brokers.ts:260` | sweep row delete                      | SEARCH sweep_brokers USING PRIMARY KEY (code=? AND minute=?)                                                                                                                                                                                                           |            1 |             0 |         12 |     0 |
| `sweep-brokers.ts:266` | sweep row replace                     | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         22 |     0 |
| `sweep-brokers.ts:291` | sweep storage count                   | SCAN sweep_brokers                                                                                                                                                                                                                                                     |      150,000 |             1 |    750,013 |  12.8 |
| `sweep-brokers.ts:450` | brokersOf                             | SEARCH sweep_brokers USING PRIMARY KEY (code=?)                                                                                                                                                                                                                        |          167 |           167 |        678 |   0.1 |
| `day-index.ts:37`      | day index row                         | (write or pragma)                                                                                                                                                                                                                                                      |            1 |             0 |         18 |     0 |
| `day-index.ts:42`      | day strip                             | SCAN days                                                                                                                                                                                                                                                              |           40 |            40 |        127 |     0 |

The broker trades index in the model holds a 200 K-row sample, because its statements are key lookups. Its row counts here do not scale with the day.

## Appendix: the scripts

<details><summary><code>audit.mjs</code></summary>

```js
// The DO SQL audit (apinrdw/kumora#531): builds a busy trading day's
// database in Node's SQLite with the real schemas from the market-live
// sources, then prints each statement's query plan, the rows it returns, the
// rows its plan visits, and SQLite's own statement counters.
//
// Save it outside the repo, then run it from the repo root:
//   node <path>/audit.mjs <db-path> [--rebuild] [--no-gaps] > out.json
// The database is reused when it exists; --rebuild makes it again.
// --no-gaps stores every trade number 1..T (a relay day with no gap).
import { existsSync, readFileSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"

const [dbPath = "do-sql-audit.db", ...flags] = process.argv.slice(2)
const rebuild = flags.includes("--rebuild")
const noGaps = flags.includes("--no-gaps")

const ROOT = pathToFileURL(`${process.cwd()}/`)
const source = (path) =>
  readFileSync(new URL(`apps/dashboard/src/server/market-live/${path}`, ROOT), "utf8")

const MINUTE_MS = 60_000
const SHARES_PER_LOT = 100

// The schemas, read from the sources so the audit runs what the objects run.
const literals = (block) =>
  [...block.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]).filter((sql) => /^\s*CREATE/.test(sql))
const daySource = source("day-store.ts")
const DAY_SCHEMA = literals(daySource.match(/const SCHEMA = \[([\s\S]*?)\n\]/)[1])
const REBUILD_CANDLE_SIDES = daySource
  .match(/const REBUILD_CANDLE_SIDES = `([\s\S]*?)`/)[1]
  .replaceAll("${MINUTE_MS}", String(MINUTE_MS))
  .replaceAll("${SHARES_PER_LOT}", String(SHARES_PER_LOT))
const CODES_SCHEMA = literals(
  source("broker-codes.ts").match(/const SCHEMA = \[([\s\S]*?)\n\]/)[1]
)
const SWEEP_SCHEMA = source("sweep-brokers.ts").match(/const SCHEMA = `([\s\S]*?)`/)[1]
const INDEX_SCHEMA = source("day-index.ts").match(/"(CREATE TABLE IF NOT EXISTS days[^"]*)"/)[1]

// The day's shape: Production's busiest measured day (#258) and the cost
// runbook's bounds.
const T = 1_460_000
const STOCKS = 900
const INDICES = 10
const MINUTES = 300
const BOOK_CODES = 30
const BOOK_MINUTES = 273
const SWEEP_BROKER_ROWS = 150_000
const DIFFERENCES = 1_000
// A relay gap every ~GAP_EVERY trades, GAP_LENGTH numbers long: 0.3% missing.
const GAP_EVERY = 10_000
const GAP_LENGTH = 30
// 2026-11-13 09:00 WIB; the trading minutes run 09:00-11:30 and 13:30-16:00.
const DAY_START = Date.UTC(2026, 10, 13, 2, 0)
const minuteAt = (index) =>
  DAY_START + (index < 150 ? index : index + 120) * MINUTE_MS

// A seeded generator, so every run builds the same day.
let seed = 531
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const code = (index) => `C${String(index).padStart(3, "0")}`
// Codes by a Zipf weight, so the liquid ones trade most.
const weights = Array.from({ length: STOCKS }, (_, i) => 1 / (i + 1))
const cumulative = []
weights.reduce((sum, weight, i) => (cumulative[i] = sum + weight), 0)
const total = cumulative.at(-1)
const pickCode = () => {
  const target = random() * total
  let low = 0
  let high = STOCKS - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (cumulative[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}
const text = (bytes) => "x".repeat(bytes)
const blob = (bytes) => {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = (random() * 256) | 0
  return out
}
const isGap = (number) =>
  !noGaps && number % GAP_EVERY >= 5_000 && number % GAP_EVERY < 5_000 + GAP_LENGTH

const build = (db) => {
  for (const statement of [...DAY_SCHEMA, ...CODES_SCHEMA, SWEEP_SCHEMA, INDEX_SCHEMA])
    db.exec(statement)
  db.exec("BEGIN")
  const trade = db.prepare("INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  const walk = db.prepare("INSERT INTO walk_trades VALUES (?, ?, ?, ?, ?)")
  const lastTime = new Map()
  for (let number = 1; number <= T; number++) {
    // IDX hands numbers out in time order (the Decision on highestWithin).
    const position = ((number - 1) * MINUTES) / T
    const minute = Math.floor(position)
    const time = minuteAt(minute) + Math.floor((position - minute) * MINUTE_MS)
    const stock = pickCode()
    const board = random() < 0.97 ? "RG" : "NG"
    if (isGap(number)) {
      walk.run(number, code(stock), 1000, 10, board)
      continue
    }
    trade.run(number, time, code(stock), 1000, 10, random() < 0.5 ? "buy" : "sell", board, "Stockbit,Ajaib")
    lastTime.set(stock, Math.max(lastTime.get(stock) ?? 0, time))
  }
  const candle = db.prepare(
    "INSERT INTO candles VALUES (?, ?, 1, 1000, 2, 1000, ?, 1000, 1000, 10, 1000000, 1, 0, 0)"
  )
  const footprint = db.prepare("INSERT INTO footprints VALUES (?, ?, ?, ?, 1)")
  for (let stock = 0; stock < STOCKS + INDICES; stock++)
    for (let index = 0; index < MINUTES; index++) {
      const minute = minuteAt(index)
      candle.run(code(stock), minute, minute + 59_000)
      if (stock < STOCKS) footprint.run(code(stock), minute, text(150), text(50))
    }
  const price = db.prepare("INSERT INTO live_prices VALUES (?, ?)")
  const ajaib = db.prepare("INSERT INTO ajaib_books VALUES (?, ?)")
  for (let stock = 0; stock < STOCKS + INDICES; stock++) {
    const time = lastTime.get(stock) ?? minuteAt(0)
    price.run(code(stock), JSON.stringify({ code: code(stock), time, pad: text(250) }))
    if (stock < STOCKS) ajaib.run(code(stock), text(1000))
  }
  const chunk = db.prepare("INSERT INTO book_chunks VALUES (?, ?, ?)")
  const heat = db.prepare("INSERT INTO heatmaps VALUES (?, ?, ?)")
  for (let stock = 0; stock < BOOK_CODES; stock++)
    for (let index = 0; index < BOOK_MINUTES; index++) {
      chunk.run(code(stock), minuteAt(index), blob(3_000))
      heat.run(code(stock), minuteAt(index), text(4_000))
    }
  const codes = db.prepare("INSERT INTO broker_code_chunks VALUES (?, ?)")
  const record = blob(7_000)
  for (let at = 6; at < 7_000; at += 7) record[at] = 65
  for (let k = 0; k < Math.ceil(T / 1_000); k++) codes.run(k, record)
  const difference = db.prepare("INSERT INTO cross_check_differences VALUES (?, ?, ?)")
  for (let i = 0; i < DIFFERENCES; i++)
    difference.run(i * 1_000 + 7, blob(6), blob(6))
  // A sample of the broker trades index: its statements are key lookups, so
  // its plan, not its size, is what matters here.
  const index = db.prepare("INSERT OR IGNORE INTO broker_trades VALUES (?, ?, ?, ?)")
  for (let number = 1; number <= 100_000; number++) {
    index.run(`B${number % 90}`, "D", "buy", number)
    index.run(`B${(number * 7) % 90}`, "F", "sell", number)
  }
  const sweep = db.prepare("INSERT OR IGNORE INTO sweep_brokers VALUES (?, ?, ?)")
  for (let i = 0; i < SWEEP_BROKER_ROWS; i++)
    sweep.run(code(i % STOCKS), minuteAt(Math.floor(i / STOCKS) % MINUTES), text(100))
  const fact = db.prepare("INSERT INTO facts VALUES (?, ?)")
  for (const [key, value] of [
    ["sealed", "2026-11-13T10:00:00Z"],
    ["feed-downs", text(200)],
    ["tape-source", "relay"],
    ["broker-codes-n", String(T)],
    ["cross-check", '{"walkedTo":"0","ended":false}'],
    ["order-flow-built", "built"],
    ["sweep-brokers-built", "split:built"],
    ["broker-trades", "built"],
    ["broker-totals", "3"],
    ["gaps", '{"gaps":[]}'],
  ])
    fact.run(key, value)
  const day = db.prepare("INSERT INTO days VALUES (?, ?)")
  for (let i = 0; i < 40; i++) day.run(`2026-10-${String(i).padStart(2, "0")}`, text(120))
  db.exec("COMMIT")
}

if (rebuild && existsSync(dbPath)) rmSync(dbPath)
const fresh = !existsSync(dbPath)
const db = new DatabaseSync(dbPath)
if (fresh) {
  const started = Date.now()
  build(db)
  db.exec("ANALYZE")
  console.error(`built ${dbPath} in ${Date.now() - started} ms`)
}

const one = (sql, ...binds) => db.prepare(sql).get(...binds)
const count = (sql, ...binds) => Number(Object.values(one(sql, ...binds))[0])
const tableRows = (table) => count(`SELECT count(*) FROM ${table}`)

// Representative bindings: a busy code, a mid-day minute, a trade number.
const BUSY = code(0)
const MID = minuteAt(150)
const MID_NUMBER = Math.floor(T / 2)
const highest = count("SELECT max(number) FROM trades")
const lowest = count("SELECT min(number) FROM trades")
const minuteRange = (minute) => {
  const [from, to] = [minute - 1, minute + MINUTE_MS - 1]
  return count("SELECT count(*) FROM trades WHERE time > ? AND time <= ?", from, to)
}
const MINUTE_TRADES = minuteRange(MID)
const MID_FIRST = count("SELECT max(number) FROM trades WHERE time <= ?", MID - 1 - 2_000)
const MID_LAST = count("SELECT max(number) FROM trades WHERE time <= ?", MID + MINUTE_MS - 1 + 1_000)

// Each statement: its call site, the SQL with sample bindings, and the rows
// its plan visits, worked out from the plan (SCAN: the table or index;
// SEARCH: the rows in the range; a correlated subquery: once a row).
const statements = [
  // day-store.ts: the object's start.
  ["schema (8 CREATE TABLE IF NOT EXISTS)", "day-store.ts:342", DAY_SCHEMA[1], [], () => 0],
  ["PRAGMA table_info(candles)", "day-store.ts:344", "PRAGMA table_info(candles)", [], () => 14],
  ["sealed fact", "day-store.ts:348", "SELECT 1 FROM facts WHERE key = ?", ["sealed"], () => 1],
  ["REBUILD_CANDLE_SIDES (old day only)", "day-store.ts:355", REBUILD_CANDLE_SIDES, [], () => tableRows("trades") + tableRows("candles")],
  // Flush writes.
  ["footprint row", "day-store.ts:415", "INSERT OR REPLACE INTO footprints VALUES (?, ?, ?, ?, ?)", [BUSY, MID, text(150), text(50), 1], () => 1],
  ["heatmap row", "day-store.ts:428", "INSERT OR REPLACE INTO heatmaps VALUES (?, ?, ?)", [BUSY, MID, text(4000)], () => 1],
  ["candle row", "day-store.ts:437", "INSERT OR REPLACE INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [BUSY, MID, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0], () => 1],
  ["fact row", "day-store.ts:455", "INSERT OR REPLACE INTO facts VALUES (?, ?)", ["feed-downs", text(200)], () => 1],
  ["trade row", "day-store.ts:464", "INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [T + 10, MID, BUSY, 1, 1, "buy", "RG", "Ajaib"], () => 1],
  ["live price row", "day-store.ts:478", "INSERT OR REPLACE INTO live_prices VALUES (?, ?)", [BUSY, text(300)], () => 1],
  ["book chunk row", "day-store.ts:487", "INSERT OR REPLACE INTO book_chunks VALUES (?, ?, ?)", [BUSY, MID, blob(3000)], () => 1],
  ["Ajaib book row", "day-store.ts:495", "INSERT OR REPLACE INTO ajaib_books VALUES (?, ?)", [BUSY, text(1000)], () => 1],
  ["fact delete", "day-store.ts:542", "DELETE FROM facts WHERE key = ?", ["seal-wake"], () => 1],
  // Reads.
  ["hasTrade", "day-store.ts:573", "SELECT 1 FROM trades WHERE number = ?", [MID_NUMBER], () => 1],
  ["boundTrade min", "day-store.ts:582", "SELECT min(number) AS number FROM trades", [], () => 1],
  ["boundTrade max", "day-store.ts:582", "SELECT max(number) AS number FROM trades", [], () => 1],
  ["storedTrades count(*)", "day-store.ts:597", "SELECT count(*) AS count FROM trades", [], () => tableRows("trades")],
  ["newestTrades (TAPE_LIMIT 10,000)", "day-store.ts:603", "SELECT * FROM trades ORDER BY number DESC LIMIT ?", [10_000], () => 10_000],
  ["firstFrom (one binary search step)", "day-store.ts:613", "SELECT number, time FROM trades WHERE number >= ? ORDER BY number LIMIT 1", [MID_NUMBER], () => 1],
  ["tradesAt final read (200)", "day-store.ts:657", "SELECT * FROM trades WHERE number <= ? AND time <= ? ORDER BY number DESC LIMIT ?", [MID_NUMBER, MID, 200], () => 200],
  ["tradesBetween range (one minute)", "day-store.ts:682", "SELECT * FROM trades WHERE number > ? AND number <= ? AND time > ? AND time <= ? ORDER BY number", [MID_FIRST, MID_LAST, MID - 1, MID + MINUTE_MS - 1], () => MID_LAST - MID_FIRST],
  ["storedCandle", "day-store.ts:698", "SELECT * FROM candles WHERE code = ? AND minute = ?", [BUSY, MID], () => 1],
  ["storedCandlesOf (whole code)", "day-store.ts:713", "SELECT * FROM candles WHERE code = ? AND minute > ? ORDER BY minute", [BUSY, -1], () => MINUTES],
  ["storedBubbles day sums", "day-store.ts:745", "SELECT code, sum(value) AS value, sum(volume) AS volume, sum(frequency) AS frequency, sum(buy_value) AS buy_value, sum(sell_value) AS sell_value FROM candles WHERE code IN (SELECT code FROM footprints GROUP BY code) GROUP BY code", [], () => tableRows("footprints") + STOCKS * MINUTES],
  ["storedBubbles newest minutes", "day-store.ts:756", "SELECT * FROM (SELECT code, minute, value, volume, frequency, buy_value, sell_value, close, row_number() OVER (PARTITION BY code ORDER BY minute DESC) AS newest FROM candles WHERE code IN (SELECT code FROM footprints GROUP BY code)) WHERE newest <= ?", [61], () => tableRows("footprints") + STOCKS * MINUTES],
  ["candlesOf", "day-store.ts:778", "SELECT * FROM candles WHERE code = ? ORDER BY minute", [BUSY], () => MINUTES],
  ["storedFootprint", "day-store.ts:791", "SELECT cells FROM footprints WHERE code = ? AND minute = ?", [BUSY, MID], () => 1],
  ["storedFootprintsOf", "day-store.ts:805", "SELECT minute, cells FROM footprints WHERE code = ? ORDER BY minute", [BUSY], () => MINUTES],
  ["orderFlowMinutes trade time", "day-store.ts:839", "SELECT time FROM trades WHERE number = ?", [highest], () => 1],
  ["orderFlowMinutes chunk span", "day-store.ts:846", "SELECT code, min(minute) AS first, max(minute) AS last FROM book_chunks GROUP BY code", [], () => tableRows("book_chunks")],
  ["minutesOfTrades", "day-store.ts:871", "SELECT min(time) AS first, max(time) AS last FROM trades WHERE number BETWEEN ? AND ?", [MID_NUMBER, MID_NUMBER + 5_000], () => 5_001],
  ["chunkOfMinute", "day-store.ts:892", "SELECT chunk FROM book_chunks WHERE code = ? AND minute = ?", [BUSY, MID], () => 1],
  ["storedNothing chunk", "day-store.ts:902", "SELECT 1 FROM book_chunks LIMIT 1", [], () => 1],
  ["orderFlowStorage footprints", "day-store.ts:925", "SELECT count(*) AS rows, coalesce(sum(length(cells) + length(sweeps)), 0) AS bytes FROM footprints", [], () => tableRows("footprints")],
  ["orderFlowStorage heatmaps", "day-store.ts:928", "SELECT count(*) AS rows, coalesce(sum(length(slices)), 0) AS bytes FROM heatmaps", [], () => tableRows("heatmaps")],
  ["storedSweeps", "day-store.ts:947", "SELECT sweeps, last_trade FROM footprints WHERE code = ? AND minute = ?", [BUSY, MID], () => 1],
  ["storedSweepsOf", "day-store.ts:963", "SELECT minute, sweeps FROM footprints WHERE code = ? ORDER BY minute", [BUSY], () => MINUTES],
  ["eachStoredSweeps page (500)", "day-store.ts:986", "SELECT code, minute, sweeps FROM footprints WHERE (code, minute) > (?, ?) ORDER BY code, minute LIMIT ?", [code(450), MID, 500], () => 500],
  ["livePrices", "day-store.ts:1016", "SELECT frame FROM live_prices", [], () => tableRows("live_prices")],
  ["livePrice", "day-store.ts:1023", "SELECT frame FROM live_prices WHERE code = ?", [BUSY], () => 1],
  ["chunkAt", "day-store.ts:1036", "SELECT chunk FROM book_chunks WHERE code = ? AND minute <= ? ORDER BY minute DESC LIMIT 1", [BUSY, MID], () => 1],
  ["heatmapOf", "day-store.ts:1049", "SELECT minute, slices FROM heatmaps WHERE code = ? ORDER BY minute", [BUSY], () => BOOK_MINUTES],
  ["latestChunks", "day-store.ts:1070", "SELECT chunk FROM book_chunks AS b WHERE minute = (SELECT max(minute) FROM book_chunks WHERE code = b.code)", [], () => 2 * tableRows("book_chunks")],
  ["ajaibBooks", "day-store.ts:1081", "SELECT code, book FROM ajaib_books", [], () => tableRows("ajaib_books")],
  ["fact", "day-store.ts:1090", "SELECT value FROM facts WHERE key = ?", ["sealed"], () => 1],
  // broker-codes.ts
  ["chunkOf", "broker-codes.ts:415", "SELECT codes FROM broker_code_chunks WHERE chunk = ?", [700], () => 1],
  ["recordedOf", "broker-codes.ts:461", "SELECT number, stockbit FROM cross_check_differences WHERE number BETWEEN ? AND ?", [700_001, 701_000], () => 1],
  ["writeFields (5,000 rows)", "broker-codes.ts:567", "INSERT OR IGNORE INTO walk_trades (number, code, price, lots, board) SELECT row.value ->> 0, row.value ->> 1, row.value ->> 2, row.value ->> 3, row.value ->> 4 FROM json_each(?) AS row WHERE row.value ->> 0 NOT IN (SELECT number FROM trades WHERE number BETWEEN ? AND ?) RETURNING number", [JSON.stringify(Array.from({ length: 5000 }, (_, i) => [MID_NUMBER + i, BUSY, 1, 1, "RG"])), MID_NUMBER, MID_NUMBER + 4999], () => 5_000 + 5_000],
  ["chunk replace", "broker-codes.ts:587", "INSERT OR REPLACE INTO broker_code_chunks VALUES (?, ?)", [700, blob(7000)], () => 1],
  ["index row delete", "broker-codes.ts:593", "DELETE FROM broker_trades WHERE broker = ? AND investor_type = ? AND side = ? AND number = ?", ["B1", "D", "buy", 91], () => 1],
  ["index row insert", "broker-codes.ts:598", "INSERT OR IGNORE INTO broker_trades VALUES (?, ?, ?, ?)", ["B1", "D", "buy", 200_000], () => 1],
  ["difference replace", "broker-codes.ts:603", "INSERT OR REPLACE INTO cross_check_differences VALUES (?, ?, ?)", [7, blob(6), blob(6)], () => 1],
  ["difference delete", "broker-codes.ts:610", "DELETE FROM cross_check_differences WHERE number = ?", [8], () => 1],
  ["status: taped count (64 chunks)", "broker-codes.ts:718", "SELECT count(*) AS count FROM trades WHERE number BETWEEN ? AND ?", [640_001, 704_000], () => count("SELECT count(*) FROM trades WHERE number BETWEEN 640001 AND 704000")],
  ["status: tape runs (lag)", "broker-codes.ts:724", "SELECT prev + 1 AS first, number - 1 AS last FROM (SELECT number, lag(number, 1, ?) OVER (ORDER BY number) AS prev FROM trades WHERE number BETWEEN ? AND ?) WHERE number > prev + 1", [640_000, 640_001, 704_000], () => count("SELECT count(*) FROM trades WHERE number BETWEEN 640001 AND 704000")],
  ["status: tape high", "broker-codes.ts:734", "SELECT max(number) AS number FROM trades WHERE number BETWEEN ? AND ?", [640_001, 704_000], () => 1],
  ["status: walk rows", "broker-codes.ts:741", "SELECT number FROM walk_trades WHERE number BETWEEN ? AND ?", [640_001, 704_000], () => count("SELECT count(*) FROM walk_trades WHERE number BETWEEN 640001 AND 704000")],
  ["status: chunk page (64)", "broker-codes.ts:757", "SELECT chunk, codes FROM broker_code_chunks WHERE chunk > ? ORDER BY chunk LIMIT ?", [639, 64], () => 64],
  ["status: differences count(*)", "broker-codes.ts:817", "SELECT count(*) AS count FROM cross_check_differences", [], () => tableRows("cross_check_differences")],
  ["heldTradesPage FIELDS_BETWEEN", "broker-codes.ts:892", "SELECT number, code, price, lots, board FROM trades WHERE number BETWEEN ? AND ? UNION ALL SELECT number, code, price, lots, board FROM walk_trades WHERE number BETWEEN ? AND ? AND number NOT IN (SELECT number FROM trades WHERE number BETWEEN ? AND ?) ORDER BY number", [640_001, 704_000, 640_001, 704_000, 640_001, 704_000], () => 2 * count("SELECT count(*) FROM trades WHERE number BETWEEN 640001 AND 704000") + count("SELECT count(*) FROM walk_trades WHERE number BETWEEN 640001 AND 704000")],
  ["holdsNone / indexBuilt", "broker-codes.ts:942", "SELECT 1 FROM broker_code_chunks LIMIT 1", [], () => 1],
  // sweep-brokers.ts
  ["storedText", "sweep-brokers.ts:217", "SELECT sweeps FROM sweep_brokers WHERE code = ? AND minute = ?", [BUSY, MID], () => 1],
  ["sweep row delete", "sweep-brokers.ts:260", "DELETE FROM sweep_brokers WHERE code = ? AND minute = ?", [BUSY, minuteAt(299)], () => 1],
  ["sweep row replace", "sweep-brokers.ts:266", "INSERT OR REPLACE INTO sweep_brokers VALUES (?, ?, ?)", [BUSY, MID, text(100)], () => 1],
  ["sweep storage count", "sweep-brokers.ts:291", "SELECT count(*) AS rows, coalesce(sum(length(sweeps)), 0) AS bytes FROM sweep_brokers", [], () => tableRows("sweep_brokers")],
  ["brokersOf", "sweep-brokers.ts:450", "SELECT sweeps FROM sweep_brokers WHERE code = ? ORDER BY minute", [BUSY], () => count("SELECT count(*) FROM sweep_brokers WHERE code = ?", BUSY)],
  // day-index.ts
  ["day index row", "day-index.ts:37", "INSERT OR REPLACE INTO days VALUES (?, ?)", ["2026-11-13", text(120)], () => 1],
  ["day strip", "day-index.ts:42", "SELECT row FROM days ORDER BY day DESC", [], () => tableRows("days")],
]

const results = []
for (const [name, site, sql, binds, visits] of statements) {
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...binds)
    .map((row) => row.detail)
    .join("; ")
  const writes = /^\s*(INSERT|DELETE|UPDATE)/i.test(sql)
  const visited = visits()
  db.exec("SAVEPOINT audit")
  const statement = db.prepare(sql)
  const started = performance.now()
  const returned = statement.all(...binds).length
  const ms = performance.now() - started
  db.exec("ROLLBACK TO audit")
  db.exec("RELEASE audit")
  results.push({
    name,
    site,
    plan,
    returned,
    visited,
    vmStep: statement.stat("vmStep"),
    fullscanStep: statement.stat("fullscanStep"),
    ms: Math.round(ms * 10) / 10,
    writes,
  })
}

// highestWithin's binary search, counted: two bounds, then one firstFrom a
// step (day-store.ts:625).
const highestWithin = (cutoff) => {
  const bound = cutoff + 1_000
  const first = db.prepare("SELECT number, time FROM trades WHERE number >= ? ORDER BY number LIMIT 1")
  let statements = 2
  let low = lowest
  let high = highest
  let found
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const row = first.get(middle)
    statements += 1
    if (row === undefined || Number(row.number) > high) {
      high = middle - 1
      continue
    }
    if (Number(row.time) <= bound) {
      found = Number(row.number)
      low = found + 1
    } else high = middle - 1
  }
  return { found, statements }
}
const search = highestWithin(MID)
const firstSearch = highestWithin(MID - 2_000)
const minuteRead = (minute) => {
  const last = highestWithin(minute + MINUTE_MS - 1)
  const first = highestWithin(minute - 1 - 2_000)
  const range = count("SELECT count(*) FROM trades WHERE number > ? AND number <= ?", first.found ?? 0, last.found)
  return { statements: last.statements + first.statements + 1, rows: last.statements + first.statements + range }
}
const midMinute = minuteRead(MID)

// The broker codes status scan (broker-codes.ts:752 `scan` and :795
// `status`), counted with the day's chunks present from chunk `from` on:
// an Ajaib walk goes newest first, so a part-walked day holds the top.
const scan = (fromChunk) => {
  let statements = 0
  let rows = 0
  let after = fromChunk - 1
  const page = db.prepare("SELECT chunk FROM broker_code_chunks WHERE chunk > ? ORDER BY chunk LIMIT 64")
  for (;;) {
    const chunks = page.all(after).map((row) => Number(row.chunk))
    statements += 1
    rows += chunks.length
    if (chunks.length === 0) break
    const low = chunks[0] * 1_000 + 1
    const high = (chunks.at(-1) + 1) * 1_000
    const taped = count("SELECT count(*) FROM trades WHERE number BETWEEN ? AND ?", low, high)
    statements += 1
    rows += taped
    if (taped !== high - low + 1) {
      statements += 2
      rows += taped + 1
    }
    const walked = count("SELECT count(*) FROM walk_trades WHERE number BETWEEN ? AND ?", low, high)
    statements += 1
    rows += walked
    after = chunks.at(-1)
    if (chunks.length < 64) break
  }
  statements += 1
  rows += tableRows("cross_check_differences")
  return { statements, rows }
}
const chunkCount = tableRows("broker_code_chunks")
const fullScan = scan(0)
const halfScan = scan(Math.floor(chunkCount / 2))

// The broker totals build's reads (broker-totals.ts via heldTradesPage):
// a chunk page and FIELDS_BETWEEN for every 64 chunks.
const totalsBuild = (() => {
  let rows = 0
  let statements = 0
  for (let first = 0; first < chunkCount; first += 64) {
    const last = Math.min(first + 63, chunkCount - 1)
    const low = first * 1_000 + 1
    const high = (last + 1) * 1_000
    const taped = count("SELECT count(*) FROM trades WHERE number BETWEEN ? AND ?", low, high)
    const walked = count("SELECT count(*) FROM walk_trades WHERE number BETWEEN ? AND ?", low, high)
    rows += last - first + 1 + 2 * taped + walked
    statements += 2
  }
  return { rows, statements: statements + 1 }
})()

// A live day's restart (trading-day.ts makeTradingDay and restoreLastFrames):
// the distinct minutes of the codes' last frames, each a minute read.
const frameMinutes = new Set(
  db
    .prepare("SELECT frame FROM live_prices")
    .all()
    .map((row) => Math.floor(JSON.parse(row.frame).time / MINUTE_MS) * MINUTE_MS)
)
let frameRows = 0
let frameStatements = 0
for (const minute of frameMinutes) {
  const read = minuteRead(minute)
  frameRows += read.rows
  frameStatements += read.statements
}
const byName = Object.fromEntries(results.map((r) => [r.name, r]))
const restart = {
  newestTrades: 10_000,
  storedBubbles: byName["storedBubbles day sums"].visited + byName["storedBubbles newest minutes"].visited,
  frameMinutes: frameMinutes.size,
  frameMinuteReads: frameRows,
  frameMinuteStatements: frameStatements,
  livePrices: tableRows("live_prices"),
  latestChunks: byName.latestChunks.visited,
  ajaibBooks: tableRows("ajaib_books"),
  eachStoredSweeps: tableRows("footprints"),
  eachStoredSweepsPages: Math.ceil(tableRows("footprints") / 500),
}
restart.total = Object.entries(restart)
  .filter(([key]) => !["frameMinutes", "frameMinuteStatements", "eachStoredSweepsPages"].includes(key))
  .reduce((sum, [, value]) => sum + value, 0)

const sizes = Object.fromEntries(
  ["trades", "candles", "footprints", "live_prices", "book_chunks", "heatmaps", "ajaib_books", "broker_code_chunks", "walk_trades", "cross_check_differences", "broker_trades", "sweep_brokers", "facts", "days"].map((table) => [table, tableRows(table)])
)

console.log(
  JSON.stringify(
    {
      gaps: !noGaps,
      sizes,
      minuteTrades: MINUTE_TRADES,
      highestWithin: { statements: search.statements, secondSearch: firstSearch.statements },
      minuteRead: midMinute,
      statusScan: { full: fullScan, halfWalked: halfScan },
      totalsBuild,
      restart,
      statements: results,
    },
    null,
    2
  )
)
```

</details>

<details><summary><code>table.mjs</code></summary>

````js
// Prints audit.mjs's JSON as Markdown: the composite figures, then one row a
// statement. Run: node <dir>/table.mjs <audit.json>
import { readFileSync } from "node:fs"

const result = JSON.parse(readFileSync(process.argv[2], "utf8"))
const { statements, ...rest } = result
console.log("```json")
console.log(JSON.stringify(rest, null, 2))
console.log("```\n")
console.log("| Site | Statement | Plan | Rows visited | Rows returned | vmStep | ms |")
console.log("| --- | --- | --- | ---: | ---: | ---: | ---: |")
for (const s of statements)
  console.log(
    `| \`${s.site}\` | ${s.name} | ${s.plan === "" ? "(write or pragma)" : s.plan.replaceAll("|", "/")} | ${s.visited.toLocaleString("en")} | ${s.returned.toLocaleString("en")} | ${s.vmStep.toLocaleString("en")} | ${s.ms} |`
  )
````

</details>
