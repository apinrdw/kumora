# Durable Object write volume and cost when every order book frame is stored

Research for [#58](https://github.com/apinrdw/kumora/issues/58), map [#38](https://github.com/apinrdw/kumora/issues/38). Read 2026-11-06.

## Answer

The design fits inside one SQLite Durable Object per trading day. Storage size and rows written are what cost money. Requests, duration and reads cost little.

- Writing one row per frame and per trade arrival costs about **$120–$260 a month in rows written**. Storage of decoded JSON order books grows by **~140 GB a month**.
- Writing order books as compressed chunks per stock code per minute, each trade once, and liveprice and candles once a minute keeps rows written at **~43–62M a month** ($0–$12 over the 50M included). Storage then grows by roughly **6–30 GB a month**.
- Recommended: the chunked design below. The bill would be about **$5–$10 a month at first**, plus about **$1.30–$6.40 a month for each month of history kept**.

## Cloudflare facts

Source: [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) (last updated Oct 18, 2026) unless noted.

### Pricing (Workers Paid, $5/month minimum per account)

| Item | Included per month | Over that |
| --- | --- | --- |
| Requests (HTTP, RPC sessions, WebSocket messages, alarms) | 1M | $0.15 per million |
| Duration | 400,000 GB-s | $12.50 per million GB-s |
| SQLite rows read | 25 billion | $0.001 per million |
| SQLite rows written | 50M | $1.00 per million |
| SQLite stored data | 5 GB-month | $0.20 per GB-month |

- **WebSocket messages:** incoming messages are billed at **20:1** ("100 WebSocket incoming messages would be charged as 5 requests"). **Outgoing WebSocket messages are free**, and so are protocol pings. Opening the socket costs one request.
- **Duration** is wall-clock time while the object is active and not eligible to hibernate, billed at 128 MB. With `acceptWebSocket()` (the Hibernation API), an idle object is not billed for duration. `ws.accept()` bills for the whole connected time. Messages answered by `setWebSocketAutoResponse()` add no duration.
- **Rows written** counts each `INSERT`, `UPDATE` and `DELETE` row. Each index on a written column adds one more row written. Row size does not matter: 1 KB and 100 KB rows each count as one. ([D1 pricing definitions](https://developers.cloudflare.com/d1/platform/pricing/), which the Durable Object page says it matches.) Deletes count as rows written, and each `setAlarm()` counts as one.
- **Storage billing** for SQLite-backed objects was switched on from January 2026 ([changelog, 2025-12-12](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/)). Stored data is billed until it is deleted.
- Workers requests: 10M a month included, then $0.30 per million ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). This design makes only a few Worker requests (socket upgrades and page loads).

### Limits

Source: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) (last updated Oct 29, 2026).

| Limit | Value |
| --- | --- |
| Storage per SQLite Durable Object | 10 GB |
| Storage per account (Paid) | Unlimited |
| String, BLOB or table row | 2 MB |
| SQL statement length | 100 KB |
| Bound parameters per query | 100 |
| Columns per table | 100 |
| CPU per request or WebSocket message | 30 s default, up to 5 min (`limits.cpu_ms`) |
| Received WebSocket message size | 32 MiB |
| Throughput | Soft limit of **1,000 requests/s per object**. Single-threaded. Too many queued requests give an "overloaded" error. |

Cloudflare publishes no separate inbound WebSocket message rate. Each message is an event on the same single thread, so the 1,000/s soft limit is the safe ceiling. Throughput also drops when each event does heavy JSON work. In-object SQLite writes are synchronous, and `put()`/SQL writes are coalesced and flushed asynchronously ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). The object's memory is 128 MB.

Alchemy binds a SQLite class by default (`storage?: "sqlite" | "legacy-kv"`, default `"sqlite"`, in `repos/alchemy/packages/cloudflare/src/Workers/DurableObject.ts`).

## Inputs

From [#43](https://github.com/apinrdw/kumora/issues/43), [#44](https://github.com/apinrdw/kumora/issues/44) and the soak test in [#48](https://github.com/apinrdw/kumora/issues/48):

- Trading time: 6 h = **21,600 s** a day. **21 trading days** a month.
- Order book: ~110 frames/s. Liveprice: ~30 frames/s. All of this is on each of the two Stockbit connections, ~70 KB/s on the wire per socket for all 690 codes.
- Running trades: 1.3–2.2M a day, which is 60–102 trades/s on average and 134–263 trades/s at peaks. Every trade arrives up to four times (two Stockbit and two Ajaib connections).
- Book side: ~0.8–1.8 KB decoded, 45–85 levels.

Assumption: each Stockbit `running_trade_batch` is about 5 frames/s, and Ajaib sends one message per trade.

## Arithmetic

### Inbound messages and requests

If the extension sends one WebSocket message per broker frame:

- 2 × (110 + 30 + 5) + 2 × 102 = **494 messages/s** on average. At a 263 trades/s peak it is 2 × 145 + 2 × 263 = **816/s**. That is close to the 1,000/s soft limit.
- 494 × 21,600 = 10.67M messages a day. At 20:1 that is 0.53M requests a day and 11.2M a month. That costs (11.2M − 1M included), rounded up to 11M, × $0.15 = **$1.65 a month**.

If the extension batches each connection's frames into one message every 250 ms, the rate is 4 × 4 = **16 messages/s**, and request cost is $0. Cost is not the reason to batch. Headroom under the 1,000/s ceiling is.

### Duration

The ingest socket sends data many times a second, so the object stays active for the whole session.

- 21,600 s × 0.128 GB = **2,765 GB-s a day**, and × 21 = **58,061 GB-s a month**. That is under the 400,000 included, so **$0**.
- Even 24 h a day for 30 days is 331,776 GB-s, still under the included amount.
- Viewer sockets must use `acceptWebSocket()` so that past-day objects with only viewers attached can hibernate.

### Rows written

| Design | Rows/day (1.3M–2.2M trades) | Rows/month | Cost over 50M |
| --- | --- | --- | --- |
| A. Row per frame, both Stockbit connections stored; trade insert + provenance update + index row + candle upsert per trade | 11.3M–14.9M | 236M–312M | **$187–$262** |
| B. Same, but frames deduped across connections | 8.2M–11.8M | 173M–248M | **$123–$199** |
| C. **Chunked** (recommended, below) | 2.05M–2.95M | 43M–62M | **$0–$12** |
| D. Everything in per-second blobs, trades too | ~0.77M | ~16M | $0 |

Where the figures come from:

- A, B: order book 110 × 21,600 = 2.38M rows/day, and liveprice 30 × 21,600 = 0.65M/day. Each is doubled when both connections are stored. Trades: 3 writes (insert, Ajaib provenance update, index on code) + 1 candle upsert = 4 × trades.
- C: 1 write per trade, plus three tables flushed at most once per code per minute: 3 × 690 × 360 = 0.75M/day. That is a ceiling; most codes do not change every minute.
- D: 21,600 per-second rows plus the same 0.75M.

Rows read cost almost nothing: 25 billion a month are included. Opening one stock code's whole day in design C reads 360 order book chunk rows.

### Storage

Each trading day has its own object, so the 10 GB per-object cap applies to one day only.

| What is stored | Per day | Per month | After 12 months | Storage bill in month 12 |
| --- | --- | --- | --- | --- |
| Decoded JSON books (110 × 2 sides × 1.3 KB + others ≈ 306 KB/s) | ~6.6 GB | ~139 GB | ~1,670 GB | ~$332 |
| Raw broker bytes (≤ 70 KB/s) | ~1.5 GB | ~32 GB | ~381 GB | ~$75 |
| Compressed chunks (estimate, 0.3 GB/day) | ~0.3 GB | ~6.3 GB | ~76 GB | ~$14 |

The decoded JSON day (6.6 GB) fits under 10 GB, but with little room. Storing both connections' copies would exceed it. Trades add ~2.2M × ~60 B ≈ 130 MB a day. The compressed figure is an estimate. Measure it on a soak-test capture before relying on it.

## Choices that keep it within limits and cheap

1. **Batch on the wire.** The extension sends one message per connection every ~250 ms (an array of frames), not one per frame. This keeps the object near 16 events/s instead of 500–800/s.
2. **Dedupe before writing.** The two hot connections carry the same order book and liveprice frames. Keep the newest frame per code in memory and store it once.
3. **Write each trade once.** Hold each trade in memory for the 5 s gap window from #44 while Stockbit and Ajaib copies merge. Then insert the merged row once, with `trade_number` as `INTEGER PRIMARY KEY` (the rowid, so no extra index row). A late trade after the window costs one `UPDATE`. Avoid a secondary index on the trades table. Candles answer per-code queries.
4. **Order books as per-code, per-minute chunks.** Use `order_book_chunk(code, minute, blob)` with primary key `(code, minute)`. The blob holds the minute's first full snapshot, then the changed levels of each later frame, gzip-compressed with `CompressionStream`. That is at most 690 × 360 rows a day, each well under 2 MB. One code's day is 360 reads.
5. **Snapshots plus deltas, not snapshots only.** Consecutive books of one code differ by a few levels. Deltas inside a chunk, with a snapshot at each chunk start, let a viewer seek to any minute without replaying the whole day.
6. **Liveprice and candles flushed once a minute.** Keep them in memory and broadcast live. Write the changed codes once a minute, and rewrite a closed candle only when a late trade changes it.
7. **Store raw broker bytes or a compact binary form, not decoded JSON.** Decoded JSON is ~4× larger and pushes a day toward the 10 GB cap.
8. **Bound the loss window.** In-memory buffers are lost if the object restarts (for example on a deploy during trading). Flushing chunks every minute bounds that loss to one minute of books. Do not deploy during trading hours.

Design D is cheaper on writes but makes per-code history scan a whole day of blobs. It also complicates late-trade inserts. Design C's extra cost, at most ~$12 a month, buys simple queries.

## Recommendation

Use **design C**: batched ingest messages, deduped frames, one row per merged trade, per-code per-minute compressed order book chunks (snapshot plus deltas), and liveprice and candles flushed per minute.

Expected monthly bill: $5 minimum, $0 for requests and duration, $0–$12 for rows written, and storage of ~$1.30–$6.40 for each month of history kept. For example, with ~0.3–1.5 GB a day, month 12 holds ~76–381 GB, about $14–$75 that month. Retention, such as moving older days to cheaper storage, is a separate decision. Make it once the real compressed size is measured.

## Open points

- Measure the real compressed size per day on a soak-test capture. Every storage figure depends on it.
- Confirm Ajaib's message rate (assumed one message per trade).
- The docs give no inbound WebSocket message rate apart from the 1,000 requests/s soft limit. Load-test the ingest path at peak rate before launch.
