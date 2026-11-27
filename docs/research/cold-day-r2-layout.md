# Cold day R2 layout: answering each recorded-day view straight from R2

Research ticket [apinrdw/kumora#548](https://github.com/apinrdw/kumora/issues/548), part of the map [apinrdw/kumora#529](https://github.com/apinrdw/kumora/issues/529), behind the decision in [apinrdw/kumora#533](https://github.com/apinrdw/kumora/issues/533). Written 2026-11-18 against `origin/staging` at `4b8a6ceb7d`.

**Question.** A recorded day moves to R2 at 10 trading days old and is answered from there as a **cold day**, never loaded back into SQL. What shape should it take in R2, so that the dashboard Worker answers each view in a few small reads? What do the reads, the storage and the move cost?

**Short answer.**

- **Store answers, not tables.** A cold day never changes, so the move writes each per-code view's **finished answer body**, gzipped, as its own object. The move builds it with the same `recordedAnswer` the object serves today. The Worker streams the object back with `Content-Encoding: gzip` and `encodeBody: "manual"`, so it never decodes it.
- **Two views take a parameter.** Tape and BrokerCodes take a cursor, and Book takes an instant. They read ranges:
  - The tape is stored as 1,000-trade blocks, each gzipped. Each block holds its trades and the 7-byte broker codes records for the same numbers. A small day index gives each block's offset and time span.
  - Each code's book is one object: its stored gzip chunks laid end to end, behind a minute index.
- **One R2 read per answer.** Every view costs **one Class B `get`**, plus one index `get` the first time an isolate meets a day (Tape) or a code (Book).
- **A busy day is about 0.25–0.4 GB in R2** (K = 900 codes with books), against 1.3–1.8 GB in SQL.
- **R2 cost.** About **4.5 K Class A writes a day**, which is about 100 K a month and inside the free 1 M. Storage grows about **8 GB a month**. Replays are about 300 Class B reads each. Storage is the only cost. It stays near **$0–1.5 a month** in the first year.
- **The move.** It reads each day table about once: about **2.6–2.8 M rows** for a busy day. It writes no rows, because `deleteAll()` resets the database file in workerd and deletes no rows one at a time. The move fits in an alarm chain of about 10–20 invocations a day, each well under the 30 s CPU budget and 128 MB of memory.

## Sources and method

- **Code read**:
  - `apps/dashboard/src/server/market-live/`: `recorded-answers.ts`, `day-store.ts`, `candles.ts`, `broker-codes.ts`, `sweep-brokers.ts`, `heat-rows.ts`, `book-chunks.ts`, `code-list.ts`, `days.ts`, `entry.ts`, `routes.ts`, `trading-day-object.ts`.
  - `packages/relay/src/recorded-day.ts` (the GET paths) and `packages/client/src/recorded-day.ts` (how the page asks).
  - The R2 adapter `apps/dashboard/src/server/archive/bucket-r2.ts`, and the buckets in `apps/dashboard/alchemy.run.ts`.
- **Sizes**: the model day of [`day-storage-by-table.md`](https://github.com/apinrdw/kumora/blob/research/day-storage-by-table/docs/research/day-storage-by-table.md) ([#546](https://github.com/apinrdw/kumora/issues/546)): 1.46 M trades, 900 codes, payload bytes per row by table. The one figure measured here is the tape's gzip size, with the script in the [appendix](#appendix-tape-block-script).
- **workerd source** at `bc7d17946518c9cc87916ebe6f799f2539ff63ac` (`src/workerd/io/actor-sqlite.c++`, `src/workerd/util/sqlite-kv.c++`), for `deleteAll()`.
- **Cloudflare docs**, all read 2026-11-18:
  - [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
  - [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
  - [R2 multipart objects](https://developers.cloudflare.com/r2/objects/multipart-objects/)
  - [Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
  - [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  - [Workers Response](https://developers.cloudflare.com/workers/runtime-apis/response/)
  - [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
  - [Cache-Control directives](https://developers.cloudflare.com/cache/concepts/cache-control/)
  - [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  - [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  - [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- **Not used**: Production's recorded data. Reading it needs the owner's session cookie (`docs/agents/production-reads.md`). [What is unconfirmed](#what-is-unconfirmed) lists what it would refine.

## The platform facts the layout rests on

| Fact                                                                                                                 | Value                                                                                                                                                                                 | Source                          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| R2 Standard storage                                                                                                  | $0.015 / GB-month, first 10 GB-month free                                                                                                                                             | R2 pricing                      |
| Class A (`PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `ListObjects`, `CopyObject`) | $4.50 / M, first 1 M a month free                                                                                                                                                     | R2 pricing                      |
| Class B (`GetObject`, `HeadObject`)                                                                                  | $0.36 / M, first 10 M a month free                                                                                                                                                    | R2 pricing                      |
| `DeleteObject`, `AbortMultipartUpload`                                                                               | free                                                                                                                                                                                  | R2 pricing                      |
| Egress through the Workers API                                                                                       | free                                                                                                                                                                                  | R2 pricing                      |
| Infrequent Access                                                                                                    | $0.01 / GB-month, Class A $9 / M, Class B $0.90 / M, $0.01 / GB retrieved, 30-day minimum, no free tier                                                                               | R2 pricing                      |
| Ranged `get`                                                                                                         | the pricing page lists only "GetObject" as Class B. It doesn't say a range read costs more than one, so this doc counts one                                                           | R2 pricing, Workers R2 API      |
| Object size                                                                                                          | 5 TiB; one `put` up to 5 GiB                                                                                                                                                          | R2 limits                       |
| Multipart                                                                                                            | parts 5 MiB to 5 GiB, all but the last the same size, at most 10,000 parts; an unfinished upload is aborted after 7 days                                                              | R2 multipart objects, R2 limits |
| Writes to one key                                                                                                    | 1 a second (429 above)                                                                                                                                                                | R2 limits                       |
| Custom metadata                                                                                                      | 8,192 bytes                                                                                                                                                                           | R2 limits                       |
| `get(key, { range: { offset, length } \| { suffix } , onlyIf })`                                                     | returns `R2ObjectBody` with a `ReadableStream` `body`; a failed `onlyIf` returns an `R2Object` with no body                                                                           | Workers R2 API                  |
| Worker isolate memory                                                                                                | 128 MB, heap and Wasm                                                                                                                                                                 | Workers limits                  |
| CPU                                                                                                                  | 30 s by default, up to 5 min configured (Workers Paid; also a Durable Object's per request)                                                                                           | Workers limits, DO limits       |
| Subrequests                                                                                                          | 10,000 an invocation by default (Paid); R2 calls count                                                                                                                                | Workers limits                  |
| Connections waiting for headers                                                                                      | 6 at a time                                                                                                                                                                           | Workers limits                  |
| Alarm wall time                                                                                                      | 15 min an invocation                                                                                                                                                                  | Workers limits, DO limits       |
| Pre-compressed bodies                                                                                                | `new Response(body, { encodeBody: "manual" })` with a `Content-Encoding` header                                                                                                       | Workers Response                |
| Cache API                                                                                                            | per data center, not replicated; `put` answers 413 when `Cache-Control` says not to cache; `match` honors `Range` and `If-None-Match`; 1,000 calls a request (Paid); 512 MB an object | Cache API, Workers limits       |
| `private`                                                                                                            | "must not be stored by a shared cache like Cloudflare"; `immutable` has no effect on Cloudflare's cache                                                                               | Cache-Control directives        |
| DO SQL                                                                                                               | rows read $0.001 / M over 25 B, rows written $1.00 / M over 50 M, storage $0.20 / GB-month over 5 GB-month; "Deletes are counted as rows written"; `setAlarm()` is one row written    | DO pricing                      |
| `deleteAll()`                                                                                                        | "removes the entire contents of a Durable Object's private SQLite database", atomic; deletes the alarm too from compatibility date 2026-02-24                                         | SQLite storage API              |

## What each view reads, and its bytes on a busy day

`recordedAnswer` (`recorded-answers.ts:72`) answers nine resources. Bubbles 404s for past days and needs no data. Sizes are for the model's busy day: 1.46 M trades, Zipf (s = 0.9) over 900 codes, books for every code. The busiest code has about 9.7 % of the trades, and per-code tables grow with its trades. "gz" is the size gzipped. Sizes not measured here are estimates from #546's payload bytes and a 5–8× gzip ratio for this JSON. The tape measured 10×.

| View                                             | Path                        | What it reads                                                                                                                                                                      | Store call                               | Busy day, answer JSON                                                                                     | gz                                |
| ------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Codes**                                        | `/codes`                    | the whole day: one KV value (`code-list.ts:215`, `CODE_LIST_KEY`)                                                                                                                  | `storage.get`                            | ~10–30 KB                                                                                                 | ~3–8 KB                           |
| **Tape**                                         | `/trades?at=&before=`       | **one instant**: the 200 trades at or before `at`, after a binary search on trade number (`day-store.ts:625`, `tradesAt` at `:650`)                                                | `trades` by rowid                        | 27 KB (136.6 B a trade, measured)                                                                         | ~5 KB                             |
| **BrokerCodes**                                  | `/broker-codes?at=&before=` | the same 200 trades, then their 7-byte records in the `broker_code_chunks` of 1,000 trades (`broker-codes.ts:692`). Plus `codesComplete`, which can scan the whole status (`:846`) | `tradesAt` + `heldCodes`                 | ~10 KB (200 × 6 B of codes, as JSON)                                                                      | ~2 KB                             |
| **Candles** (with footprints and previous close) | `/candles/{code}?v=6`       | **one code, the whole day**: `candles` and `footprints` by `(code, minute)`, and one `live_prices` row                                                                             | `candlesOf`, `footprintsOf`, `livePrice` | median code < 50 KB; busiest ~5–7 MB (≤ 300 × ~250 B candles + ~9.7 % of the 68 MB footprints payload)    | busiest ~1 MB                     |
| **Sweeps**                                       | `/sweeps/{code}`            | one code, the whole day: the `sweeps` column of `footprints` (`candles.ts:663`)                                                                                                    | `storedSweepsOf`                         | busiest ~2–4 MB                                                                                           | ~0.5 MB                           |
| **SweepBrokers**                                 | `/sweep-brokers/{code}`     | one code, the whole day: `sweep_brokers` by `(code, minute)` (`sweep-brokers.ts:448`)                                                                                              | `brokersOf`                              | busiest ~5–12 MB (9.7 % of 120 MB payload at the model's 0.74 sweeps a trade; ~5 MB at the runbook's 0.3) | ~1–2 MB                           |
| **Book**                                         | `/books/{code}?minute=`     | **one code, one instant**: the chunk at or before the minute (`day-store.ts:1035`)                                                                                                 | `chunkAt`                                | 3–30 KB                                                                                                   | 0.5–5 KB (stored gzipped already) |
| **Heatmap**                                      | `/heatmap/{code}`           | one code, the whole day: `heatmaps` by `(code, minute)` (`day-store.ts:1049`)                                                                                                      | `heatmapOf`                              | ~850 KB (273 × 3.1 KB)                                                                                    | ≤ 98 KB (≤ 360 B a row, #546)     |
| **Gaps**                                         | `/gaps`                     | the whole day: one fact                                                                                                                                                            | `fact(Fact.gaps)`                        | < 5 KB                                                                                                    | < 1 KB                            |

What the page asks for (`packages/client/src/recorded-day.ts`):

- **On opening a day**: Codes, Gaps and the tape at a cursor.
- **For each selected code**: Candles, Sweeps, SweepBrokers and Heatmap, once each.
- **For each minute it scrubs to**: one Book.
- **For each page it walks back**: a Tape and a BrokerCodes.

The browser keeps a sealed answer by its whole URL.

**Tables no view reads.** `broker_trades` is the Data Studio index (`broker-codes.ts:52`), and no answer reads it. The broker codes chunks rebuild it. `walk_trades` is read only by the build (#425). `ajaib_books` and `cross_check_differences` are read by no recorded answer. Whether these four leave the day with the move is a spec choice: the Destination counts views, not tables. Together they are about 100 MB in SQL, and nearly all of that is `broker_trades`.

## Layout 1 (recommended): finished answers per code, a block tape, and a book index

Bucket: a new `MARKET_LIVE_DAYS_BUCKET`, declared like the archive buckets in `alchemy.run.ts`. It is on every stage, with `forceDestroy` off only in Production. Keys sit under `days/{date}/`:

| Key                                        | Content                                                                                                                                                                                                                                                                                      | Encoding                                                                                                                                                      | Objects a busy day |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `days/{date}/codes.json.gz`                | the Codes answer body, as `codeListAnswer` returns it                                                                                                                                                                                                                                        | gzip                                                                                                                                                          | 1                  |
| `days/{date}/gaps.json.gz`                 | the Gaps answer body                                                                                                                                                                                                                                                                         | gzip                                                                                                                                                          | 1                  |
| `days/{date}/candles/{code}.json.gz`       | the Candles answer body (`encodeRecordedCandles`)                                                                                                                                                                                                                                            | gzip                                                                                                                                                          | ≤ 900              |
| `days/{date}/sweeps/{code}.json.gz`        | the Sweeps answer body (`encodeRecordedSweeps`)                                                                                                                                                                                                                                              | gzip                                                                                                                                                          | ≤ 900              |
| `days/{date}/sweep-brokers/{code}.json.gz` | the SweepBrokers answer body (`encodeRecordedSweepBrokers`), `complete` as it stood at the move                                                                                                                                                                                              | gzip                                                                                                                                                          | ≤ 900              |
| `days/{date}/heatmap/{code}.json.gz`       | the Heatmap answer body (`heatmapAnswer`, sealed form)                                                                                                                                                                                                                                       | gzip                                                                                                                                                          | ≤ 900              |
| `days/{date}/books/{code}.bin`             | the book index, then every `book_chunks.chunk` BLOB of the code laid end to end, in minute order                                                                                                                                                                                             | index: `u32` count, then `count × (u32 minute offset in seconds from the day's start, u32 byte offset, u32 length)`; chunks: the stored gzip bytes, unchanged | ≤ 900              |
| `days/{date}/tape/{segment}.bin`           | 100 tape blocks (100 K trade numbers) laid end to end. Block `b` holds the numbers `b·1000+1 … b·1000+1000` that the day has: gzip of `encodeRecordedTape({ trades })`, then gzip of the same 7,000-byte `broker_code_chunks` record for those numbers (`broker-codes.ts` `CHUNK`, `RECORD`) | gzip members                                                                                                                                                  | ~15                |
| `days/{date}/tape-index.json.gz`           | one entry a block: `[block, segment, offset, length, codesOffset, codesLength, minTime, maxTime]`, plus the trade count and `codesComplete`                                                                                                                                                  | gzip JSON                                                                                                                                                     | 1                  |
| `days/{date}/manifest.json`                | written **last**: the layout version, the `ViewerProtocolVersion` the answers were encoded with, and the object count. Its presence says the day moved                                                                                                                                       | JSON                                                                                                                                                          | 1                  |

Total: about **4,520 `put`s** for a busy day with 900 codes, all with fixed keys. The 1-a-second limit is per key, so the move can run up to the 6 connections at a time without a limit. Rerunning a part rewrites the same bytes, so the move is idempotent.

**Why answers and not rows.** A cold day is fixed, so its answers are fixed. Writing the body that `recordedAnswer` already builds has three gains:

- **The bytes don't change.** The answer is byte for byte the one a hot day sent, so a browser that cached the hot URL loses nothing.
- **The Worker only streams.** It needs no decoder and no builder code, and it holds no rows in memory. The busiest code's SweepBrokers is 5–12 MB of JSON. Rebuilding that from rows in a 128 MB isolate is the one risky case, and this layout never does it.
- **One `get` an answer**, with no index read for the per-code views.

The cost is the encoding. If a later change alters a recorded answer's shape, every cold day needs a one-off rewrite, which decodes each old body and re-encodes it. The `manifest.json` records the encoding the bodies use, so such a rewrite can find the days it must change. Candles already carries `?v=` in its path for the browser's sake (`recorded-day.ts:88`).

### Each view's R2 operations, latency and Worker memory

The Worker gates the request first, as `days.ts` `gatedRead` does today. It then reads R2 in place of `TRADING_DAY.getByName(date)`.

| View                                                | R2 operations an answer                                                                                                                                                                                                                                                                                                                  | Worker work and memory                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codes, Gaps, Candles, Sweeps, SweepBrokers, Heatmap | **1 `get`** of the whole object. A missing key gives the same answer the object gives today for a code with nothing (a 404, or the empty answer the builder makes)                                                                                                                                                                       | Streams `object.body` into the `Response` with `Content-Encoding: gzip` and `encodeBody: "manual"`. Holds about 0 bytes, and the CPU is a few ms                                                                                                                                          |
| **Tape**                                            | **1 ranged `get`**: the block where `highestWithin` lands and the block before it, which sit next to each other in one segment. A cursor that crosses a segment boundary takes 2, about 1 % of cursors. On the first ask for this day in this isolate, add **1 `get`** of `tape-index.json.gz` (1,460 entries, ~90 KB raw, ~20–30 KB gz) | Gunzip ≤ 2 blocks (~28 KB gz, ~270 KB JSON), decode up to 2,000 trades, then apply the same number and time filters as `tradesAt` (`TIME_SKEW_MS` = 1 s). The block holding the highest number at or before `at` + 1 s is the last block whose `minTime ≤ at + 1 s`. Under 1 MB of memory |
| **BrokerCodes**                                     | **1 ranged `get`** of the same blocks' code records (the codes sit beside the trades, so a range can take both), plus the index read the first time                                                                                                                                                                                      | Gunzip ≤ 2 × 7,000 B, then read 200 records. `complete` comes from the index, with no status scan                                                                                                                                                                                         |
| **Book**                                            | **1 ranged `get`** of the chunk. On the first ask for this code in this isolate, add **1 ranged `get`** of the first 4 KB, the index (273 × 12 B + 4 B ≈ 3.3 KB)                                                                                                                                                                         | A binary search of the index for the last minute ≤ the asked minute, then the chunk streamed unchanged with `Content-Encoding: gzip`. A miss is the same 404 "Not recorded"                                                                                                               |

Keep the tape and book indexes in isolate memory, in a `Map` capped by count. That way a replay, which scrubs one code's book and walks one day's tape, pays the index read about once.

**Latency.** Cloudflare publishes no figure for an R2 `get` from a Worker, and none was measured here. An answer is one R2 round trip, plus the index round trip the first time, after the gate's session read. That is the same structure as today's one Durable Object round trip, but without the object's wake and SQL. A Staging run should measure p50 and p95 for the busiest code's SweepBrokers and for a Book. The bucket's location also matters: the jurisdiction or location hint, near Singapore for an IDX audience. See [unconfirmed](#what-is-unconfirmed).

### Monthly R2 cost

Assumptions: 22 trading days a month. A busy day is about 0.25–0.4 GB in R2:

- book chunks: ~0.2 GB, already gzipped
- heatmaps: ≤ 0.09 GB
- tape and codes: ~0.025 GB
- Candles, Sweeps and SweepBrokers: ~0.05 GB

A replay is a viewer opening a cold day and looking at about 10 codes: 3 day-level `get`s, 40 per-code `get`s, about 200 Book `get`s while scrubbing, and about 50 tape pages with their broker codes, about 300 `get`s in all.

| Term                      | Each month                                                                  | Price                        | Cost                                                 |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Class A, the steady move  | 22 × ~4,520 ≈ 100 K                                                         | first 1 M free               | **$0** (if the full price applied: $0.45)            |
| Class A, the one-off move | ~4,520 per moved day, once; ~30 days ≈ 136 K                                | first 1 M free               | **$0**                                               |
| Class B, 100 replays      | 30 K                                                                        | first 10 M free              | **$0**                                               |
| Class B, 10,000 replays   | 3 M                                                                         | first 10 M free              | **$0**                                               |
| Storage                   | +~5.5–9 GB a month; a year in: ~70–110 GB, plus ~2 GB from the one-off move | $0.015 / GB-month over 10 GB | **~$0–1.5 a month**, rising ~$0.1 a month each month |

The free tiers are per account. The shareholding, KSEI and logo buckets draw on them too, but their volume is a few runs a month. Class B stays free up to about 33 K replays a month. Infrequent Access doesn't pay: on 100 GB it saves $0.50 a month, but it has no free tier, Class B costs 2.5×, and every replay adds $0.01 / GB retrieved.

### Caching

- **What the answers send today.** A sealed day's Tape, Candles, Sweeps, Book, Heatmap and Gaps send `SEALED_CACHE` = `private, max-age=31536000, immutable` (`routes.ts:54`). Codes sends the same for a past date (`code-list.ts:89`). BrokerCodes and SweepBrokers send `private, max-age=60` when complete, and `no-store` when not (`recorded-answers.ts:36`, `:120`, `:155`).
- **A cold day should send `SEALED_CACHE` for every view**, BrokerCodes and SweepBrokers included. Those two are cached a minute only because a later batch can rewrite a trade's codes (`recorded-answers.ts:33`). A cold day is past 10 trading days, so no batch reaches it (#533). This also ends the [#545](https://github.com/apinrdw/kumora/issues/545) pattern on cold days: the page rechecked an incomplete sealed day every 30 s, and each recheck woke the object and rescanned the day. On R2, an incomplete cold day still answers `complete: false`. The page should treat a cold day as final, or each open tab costs 2 × 2,880 `get`s a day. That is free under the 10 M, but it is waste. That is a page change for the spec.
- **The browser's cache is the main shield.** It keeps every per-code answer and every Book minute a viewer has asked for, by URL, for a year. A replay of the same day by the same viewer goes to R2 only for minutes and cursors it hasn't seen.
- **The Cache API is optional.** Class B is free at any plausible replay volume, so caching saves latency, not money. The Cache API is per data center. Cloudflare won't store a `private` response, and `put` 413s when `Cache-Control` forbids it. So the Worker would `put` a copy under the R2 key's URL with `Cache-Control: s-maxage=31536000`, after the gate, and send the viewer the `SEALED_CACHE` copy. The content is the same for every signed-in viewer, so a shared copy behind the gate leaks nothing. Worth it for the two indexes (tape and book), so a new isolate in the same data center skips that first `get`. Not worth it for the bodies at first. The docs don't say the Cache API is billed. Recent Cloudflare docs don't price it, but that is unconfirmed.

## Layout 2 (alternative): rows per table, in code-sorted blocks

Keys `days/{date}/{table}.bin` for `trades`, `candles`, `footprints`, `sweep_brokers`, `heatmaps`, `book_chunks` and `broker_code_chunks`, plus `facts.json`, `live_prices.json` and the code list.

- **Order.** Each table file holds its rows in primary-key order, `(code, minute)` or `number`, cut into blocks of about 64 KB raw, each gzipped. A footer gives each code's first and last block, and the last 8 bytes give the footer's length.
- **Encoding.** The rows keep their SQL text: `cellsText`, `sweepsText`, `slicesText`, `encodeSweepBrokersText`. The Worker would rebuild each answer with the same decoders the day store uses (`cellsFromText`, `slicesFromText`, `sweepsFromText`).
- **Gains:**
  - About 10 objects a day instead of 4,500.
  - The rows are independent of the answer encoding, so a protocol change needs no rewrite of cold days.
  - Other uses, like a future Data Studio-like export, read the raw tables.
- **Costs:**
  - **2 `get`s a per-code answer**: the footer (from a suffix range, or a cache) and the code's blocks. The Candles answer needs 3: candles, footprints, and `live_prices` for the previous close.
  - **Worker CPU and memory to rebuild.** The busiest code's SweepBrokers decodes ~5–12 MB of row text into objects, then encodes it again. That is tens of MB of heap against 128 MB, and far more CPU than streaming bytes.
  - **The day store's answer code runs against a second backend.** The builders read through `Sql`. Each would need a path that reads decoded blocks, and a test that the two paths agree.
  - **The move needs multipart writes.** A table file is too large to build in memory: `heatmaps` is ~770 MB raw, about 90 MB gzipped. The upload has to be multipart, with every part but the last the same size of at least 5 MiB, spread over several alarm invocations. The upload ID has to survive restarts, and it expires after 7 days.

Layout 1 needs no new reader for the tables, and its Worker work is the smallest. Choose Layout 2 only if keeping the raw rows outweighs those costs. Writing Layout 1 plus a raw `trades` tape costs nothing extra, because the tape blocks _are_ the raw trades.

## The move: rows read, writes, and fitting it in alarms

### Rows read to export one busy day

Each table is read once, in primary-key order. The reads are `WHERE code = ? ORDER BY minute` for each code in the day's code list, or a keyset page `WHERE number > ? ORDER BY number LIMIT ?` for the tape. These order by the primary key, so SQLite needs no sort, and a sort is what bills again (#530). The move must not list codes with the `GROUP BY` that `day-store.ts:734` uses, because that bills the table a second time. It takes the codes from the code list instead.

| Table                                                                         |       Rows read |
| ----------------------------------------------------------------------------- | --------------: |
| `trades` (tape blocks)                                                        |       1,460,000 |
| `broker_code_chunks` (tape codes)                                             |           1,460 |
| `candles`                                                                     |         222,788 |
| `footprints` (Candles; read once more for Sweeps unless the two share a pass) | 222,788–445,576 |
| `sweep_brokers`                                                               |         222,788 |
| `heatmaps`                                                                    | 125,000–245,700 |
| `book_chunks`                                                                 | 125,000–245,700 |
| `live_prices`, `facts`, KV keys                                               |          ~1,000 |
| **A busy day**                                                                |  **~2.4–2.8 M** |

That is about 0.01 % of the 25 B rows read included each month. A one-off move of about 30 recorded days is under about 85 M rows, about 0.3 %. Lighter days read fewer. The day count in Production is not read here: 7.4 GB at 0.2–1.8 GB a day, with books on only the newer days.

### Rows written, and `deleteAll()`

- **The export writes no SQL rows.** It only reads. A progress cursor kept in KV (`storage.put`) is 1 row written a chunk, and each `setAlarm()` is 1 row written (DO pricing). That is about 20–40 rows a day.
- **`deleteAll()` deletes no rows one at a time.** In workerd, `ActorSqlite::deleteAll` (`actor-sqlite.c++:867`) calls `SqliteKv::deleteAll` (`sqlite-kv.c++:199`). That runs one `count(*)` over the hidden KV table, only to return a count, and then `db.reset()`, which drops the whole database. No `DELETE` statement runs over the day's tables. So the rows-written meter has nothing to count: "Deletes are counted as rows written" applies to deletes that run. The `count(*)` reads the day's KV keys, a few dozen. Production's storage layer is not open source, and the pricing page doesn't say how `deleteAll()` bills. So "free in rows" is **likely, unconfirmed**. The check: compare `durableObjectsPeriodicGroups` rows written for the namespace on the day of a Staging move against the cursor counts the move logs.
- **The order of steps.** Write every object. Write `manifest.json` last. Mark the day cold in the day index, which writes 1 row. Then call `deleteAll()`. `deleteAll()` cannot run inside a transaction (`actor-sqlite.c++:903`). From compatibility date 2026-02-24 it also deletes any alarm, so the move's last step sets no alarm after it. A failure before the manifest leaves the day hot, and the next run rewrites the same keys.

### Fitting it in an alarm chain

**The limits.** Each alarm invocation has 15 minutes of wall time, 30 s of CPU by default (up to 5 minutes if configured), 128 MB of memory and 10,000 subrequests.

- **Chunk by code.** Each invocation takes the next N codes of the code list and writes their six objects: four answers, the book file, and the index inside it. It saves the position in KV and sets the next alarm.
  - CPU per code is mostly the answer encoders and gzip. A gzip of ~1 GB of answer JSON over the whole day runs at roughly 50–100 MB/s at the default level. With the Schema encode on top, the day is about 30–90 s of CPU. That is about 10–20 invocations of 50–100 codes each, for well under 30 s each.
  - Memory per code is at most the busiest code's answers, ~15–25 MB of JSON at once.
  - Subrequests are at most ~600 `put`s an invocation.
- **The tape is its own step.** 15 segments, each built from a keyset scan of 100 K trades, about 14 MB of JSON before gzip. 15 `put`s of about 1.4 MB each, one or a few segments an invocation, with no multipart.
- **No write burst.** The move writes no SQL rows. Its R2 writes go to distinct keys, under 6 connections at a time. The one-off move runs one day a night from the oldest: about 30 nights, or several days a night, since nothing here limits it. Each day's chain is independent, so a failed day only delays that day.
- **What starts the move** (the reconcile cron, the seal of the 11th day, or an alarm) and how a request is routed hot or cold are the map's "The move itself", not this ticket. The layout makes routing simple. The day index knows which days are cold. The `manifest.json` is the fallback check: a `head` is one Class B.

## What is unconfirmed

- **R2 latency** from the dashboard Worker, by object size and location. Not published by Cloudflare, and not measured here.
- **Whether a ranged `get` bills as one Class B**, as assumed. The pricing page lists only "GetObject".
- **Whether `deleteAll()` is free in billed rows written** in Production. workerd resets the file, but the billing layer is closed.
- **Per-code answer sizes.** The busiest code's Candles, Sweeps and SweepBrokers come from #546's synthetic day: 0.74 sweeps a trade, Zipf trades. A sealed Production day's GETs for its busiest code, read with the owner's cookie, would refine them. So would the gzip ratios, apart from the tape's, which was measured.
- **The number of recorded days in Production**, and each one's size. This sets the one-off move's nights and rows, not its shape.
- **Whether the Cache API is free**, and how `cache.put` treats `private` exactly. The docs say only "consistent with Cloudflare Cache-Control Directives".
- **Account-wide R2 free tier use** by the existing archive and logo buckets.

## Appendix: tape block script

Measures the tape at 136.6 bytes a trade as `RunningTrade` JSON: 199 MB for 1.46 M trades, which gzips to 19.9 MB in 1,000-trade blocks of about 13.6 KB each. Save it outside the repo and run `node tape-blocks.mjs`.

```js
// Tape block sizes (apinrdw/kumora#548): a busy day's 1.46 M trades as
// RunningTrade JSON (the tape answer's encoding), cut into 1,000-trade blocks
// by number, each gzipped; prints the day's and a block's bytes.
import { gzipSync } from "node:zlib"

const T = 1_460_000
const BLOCK = 1_000
const STOCKS = 900
let seed = 548
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const cumulative = []
let sum = 0
for (let i = 0; i < STOCKS; i++) cumulative.push((sum += 1 / (i + 1) ** 0.9))
const pick = () => {
  const target = random() * sum
  let low = 0
  let high = STOCKS - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (cumulative[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const code = (i) =>
  [i % 26, (i / 26) % 26, (i / 676) % 26, 7].map((n) => LETTERS[Math.floor(n)]).join("")
const price = Array.from({ length: STOCKS }, () => 50 + Math.floor(random() * 10_000))
const start = Date.UTC(2026, 10, 13, 2, 0)
const span = 5 * 3_600_000
let json = 0
let gz = 0
let largest = 0
for (let first = 1; first <= T; first += BLOCK) {
  const trades = []
  for (let n = first; n < first + BLOCK && n <= T; n++) {
    const c = pick()
    trades.push({
      tradeNumber: n,
      time: start + Math.floor(((n - 1) / T) * span) + Math.floor(random() * 2_000),
      code: code(c),
      price: price[c],
      lots: random() < 0.02 ? 50 * Math.ceil(random() * 40) : Math.ceil(-40 * Math.log(1 - random())),
      side: random() < 0.5 ? "Buy" : "Sell",
      board: random() < 0.97 ? "RG" : "NG",
      feeds: ["Ajaib", "Stockbit"],
    })
  }
  const text = JSON.stringify({ trades })
  const packed = gzipSync(text).length
  json += text.length
  gz += packed
  largest = Math.max(largest, packed)
}
const blocks = Math.ceil(T / BLOCK)
console.log(JSON.stringify({ blocks, jsonMB: json / 1e6, gzipMB: gz / 1e6, meanBlockKB: gz / blocks / 1e3, largestBlockKB: largest / 1e3, jsonBytesPerTrade: json / T }))
```

Output: `{"blocks":1460,"jsonMB":199.46,"gzipMB":19.90,"meanBlockKB":13.63,"largestBlockKB":13.89,"jsonBytesPerTrade":136.62}`. Real prices and lots vary less than the uniform random ones here, so real blocks likely gzip a little better.
