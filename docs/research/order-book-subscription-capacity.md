# How many codes' order books the relay can keep subscribed, and how fast they update

Research for [#486](https://github.com/apinrdw/kumora/issues/486), map [#485](https://github.com/apinrdw/kumora/issues/485). Written 2026-11-18 from the code at `4df619d2af`, earlier research in `docs/research/`, and Cloudflare's docs. No production data was read and no live probe was run.

## Short answer

- **The map's premise is half wrong.** Only Ajaib's book is limited to the selected and watchlist codes. Stockbit's `order_book` is already subscribed for **every listed code**, about 3,400 codes, on both connections. The trading-day object already decodes every one of those books, sends every changed book to **every viewer** in each 250 ms delta, and records a book chunk per code per minute. A whole-market scanner needs no new subscription on Stockbit.
- **Largest practical N.** Stockbit: the whole market. It has run with 690 codes in probes and with the full list in production. Its practical limit is not the code count but the 09:00 open, where the full-load socket dropped with `1006`. Ajaib: the on-demand set, tens of codes. One `SUBSCRIBE` per code, no documented limit, observed with only 3 codes in a probe and the owner's watchlist (about 30) in production. Hundreds of Ajaib codes is untested.
- **Update cadence.** A Stockbit book frame is a full snapshot of one side. In Session 2 a typical active code sends about 0.24 side frames a second, and the busiest about 2–3 a second (BBCA 2.6). About 450–480 codes send a book frame in a given minute. The 09:00 open is about 3–3.5× Session 2. Ajaib sends deltas batched every 150 ms, about 2–2.8 frames a second for a busy code. Viewers see at most 4 updates a code a second, because the object coalesces into 250 ms deltas.
- **Cost.** The object already pays the whole-market book cost: about 200–320 side frames a second from two connections in Session 2, about 700–900 at the open, and up to one chunk row per active code per minute. The viewer socket already carries every changed book: an **estimated 150–270 KB/s of JSON per viewer in Session 2 and about 0.5 MB/s at the open**, before any WebSocket compression. That viewer cost, not the subscription, is the scanner's real constraint.

## 1. What is subscribed today

### Stockbit: every listed code

`subscribeFrame` in `apps/extension/src/worker/stockbit.ts` builds one cumulative channel message: `order_book`, `liveprice` and `iepiev` with every code, and `running_trade_batch` with `["*"]`. The comment there says `"*"` is the only wildcard Stockbit honours, so each channel lists the codes explicitly.

The codes come from `codeList.codes` (`apps/extension/src/worker/service-worker.ts`, `makeStockbitSubscriptions(codeList.codes, …)`). That is Ajaib's whole code list, fetched once a WIB day (`apps/extension/src/worker/code-list.ts`). It held 3,406 entries on 2026-11-06, warrants included (`listedCodes` in `apps/extension/src/worker/ajaib.ts`). The extension glossary says the same: "Stockbit's channel message lists every code on it" (`apps/extension/GLOSSARY.md`, **Code list**).

Both connections, A and B, carry the same subscription (`connections = ["A", "B"]` in `subscriptions.ts`).

### Ajaib: the on-demand codes only

`makeAjaibSubscriptions` (`subscriptions.ts`) keeps `PRICE`, `INDICATIVE` and `ORDER_BOOK_CUSTOM` subscribed for the **on-demand codes**: the union, across both targets, of every code a viewer has selected or in a watchlist (`on-demand.ts` in the dashboard, `on-demand-codes.ts` in the extension). `onDemandMessages` (`ajaib.ts`) sends one `SUBSCRIBE` or `UNSUBSCRIBE` per code, only for the difference. A code a target newly asks for is sent `UNSUBSCRIBE` then `SUBSCRIBE`, so Ajaib resends its whole book.

Ajaib's book is served only as a fallback. `served` in `apps/dashboard/src/server/market-live/order-books.ts` prefers Stockbit while Stockbit is live and falls back to Ajaib, and the other way round.

### The map note to correct

The map says "Books are subscribed only for the selected and watchlist codes, not the whole market." That holds for Ajaib only. For Stockbit, the primary book source, the whole market is already subscribed and already reaches every viewer.

## 2. Limits on each site

### Stockbit

- **No documented code limit.** The schema's `WebsocketChannel` holds `repeated string` codes per channel (`docs/research/stockbit-live-data.md`, `live-price-channels.md`). Stockbit's own web app subscribes per code through the same cumulative message, resent in full on each change.
- **Observed.** Probes with 690 codes held a full-load socket for 51 minutes in Session 2 on 2026-11-06 (`broker-frame-rates.md`). Production lists the whole code list.
- **Disconnects.**
  - The full-load socket dropped with `1006` at **09:00:02** on 2026-11-09, the opening burst, and reopened 30 s later (`broker-frame-rates.md`). Spec [#138](https://github.com/apinrdw/kumora/issues/138) expects this and reconnects at once.
  - Session 2 sockets dropped with `1006` after 51 and 61 minutes, cause unknown, not a ping timeout (`broker-websocket-heartbeats.md`).
  - Nothing shows that fewer codes would avoid these drops. The open drop coincides with about 400–500 frames a second on that socket.
- **Wildcards.** `order_book: ["*"]` is unproven. Stockbit's web app never sends it, and one open-source client says the server rejects `*` for books (`live-price-channels.md`). The explicit list already works, so this doesn't matter.

### Ajaib

- **No documented code limit.** Ajaib's web app subscribes `ORDER_BOOK_CUSTOM` with one code per message (`streamObject: <code>`) and never `*` (`live-price-channels.md`).
- **Observed.** A probe held 3 codes for 30 minutes on 2026-11-09 (`broker-frame-rates.md`). Production holds the on-demand set, about 30 codes when the owner's watchlist is open. Nothing larger has been tried.
- **Subscribing N codes.** A cold start or reconnect sends N `SUBSCRIBE` messages at once. Each code's book comes back as an `is_initial` snapshot, then deltas. Throttling, a per-socket cap, or a burst limit for N in the hundreds is **unknown**.
- **Server-side state.** The object stores each Ajaib book whole, one row per on-demand code, rewritten by each minute flush that saw it change (`takeAjaibBooks`, `order-books.ts`, Decision for [#157](https://github.com/apinrdw/kumora/issues/157)). Rows written grow linearly with N.

## 3. What a frame carries

|             | Stockbit `order_book` (v1, wrapper case 10)                                             | Ajaib `ORDER_BOOK_CUSTOM`                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Kind        | **Snapshot of one side** per frame, bid or offer                                        | **Deltas** per level. An `is_initial: "true"` frame replaces the whole book. A level with `lot` 0 is deleted |
| Body        | Pipe text `#O\|CODE\|BID or OFFER\|price;orders;shares\|…\|<epoch s>-<orders>&<shares>` | JSON `{ ticker, is_initial?, buy?, sell?, updateTime }`, each level `{ price, lot, num }`                    |
| Levels      | The whole side: 45–85 levels, average 44–62 in captures                                 | Only the levels that changed                                                                                 |
| Order count | Yes, per level (`orders`)                                                               | Yes, per level (`num`)                                                                                       |
| Side totals | Yes, whole-side orders and shares in the trailer                                        | No. The object sums the levels it holds (`lotsOf`)                                                           |
| Size        | About 0.53 KB on the wire, 0.8–1.4 KB as text in captures                               | Small. Not measured                                                                                          |
| Batching    | One frame per side change                                                               | Batched every 150 ms by Ajaib                                                                                |

Sources: the parsers `sideBookOf` and `AjaibOrderBook` in `order-books.ts`; `live-price-channels.md` (§1 and the Ajaib table); `broker-frame-rates.md` (bytes per frame).

The served book (`packages/relay/src/order-book.ts`) keeps `BOOK_DEPTH` = 20 levels a side, best first, each with price, lots and orders, plus whole-book lot totals. For Ajaib, the whole-book totals cover only the levels Ajaib has sent.

## 4. Update cadence

All Stockbit rates are per socket. The relay holds two, and the object drops the slower copy of each side (`newerThanHeld`).

| When                                                    | Book side frames a second                         | Codes with a book frame in a minute | Per code                                  |
| ------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| Session 2, typical (2026-11-06, 15:00–15:30, 690 codes) | 99–119                                            | 449–472                             | Average about 0.24/s. Busiest about 2–3/s |
| Session 2, busiest measured minute (14:44)              | 160                                               | 474                                 |                                           |
| Session 2, last ten minutes (15:40–15:50)               | about 200–250 (estimate, scaled from trade rates) |                                     |                                           |
| 09:00 open (2026-11-09)                                 | about 360 (estimate from a 450 f/s total)         |                                     | About 3–3.5× Session 2                    |
| Pre-opening and closing auction                         | Little. Mostly `iepiev`                           |                                     |                                           |

Source: `broker-frame-rates.md`. The probes listed 690 codes. With the 3,406-code production list, that note estimates 10–25% more load, since only codes that trade send frames (865 codes traded on 2026-11-02).

A per-code distribution has **not** been measured. The probes counted frames per channel, not per code. The three anchors above are all there is: about 460 active codes a minute, BBCA at 2.6/s, and the 250 most active codes sending about 78% of book frames.

Ajaib: BBCA, BBRI and GOTO together sent 5.3–8.4 frames a second, about 2–2.8 each, in Session 2 (`broker-frame-rates.md`). At a 150 ms batch, one code can send at most about 6.7 frames a second.

**What viewers see.** `sendDelta` (`trading-day.ts`) runs at most every `DELTA_INTERVAL` = 250 ms. `takeChanged` (`order-books.ts`) coalesces each code's frames since the last delta into one served book. So a code updates at most 4 times a second on the page, whatever the feed sends. A quiet code can go minutes without a frame.

## 5. Cost on the trading-day object

The whole-market Stockbit book cost is **already paid** today. A scanner adds only what it computes from the books.

- **Decoding.** `stockbitFrames` decodes every case-10 frame from both connections: about 200–320 side frames a second in Session 2 and about 700–900 at the open. These arrive in about 16 envelopes a second, batched every 250 ms by the relay (spec #138, "Storage and cost"). That is far under the soft limit of 1,000 requests a second. The constraint is the object's single thread (`durable-object-ingest-limits.md`).
- **Building served books.** Every changed code's book is sorted to 20 levels a side each delta (`best`, `served`). At about 100–150 changed codes a second, that is 25–40 books a tick.
- **Storage.** `bookChunks.record` runs for every served book, of any code. That gives one gzip chunk row per active code per minute: up to about 460 rows a minute, about 0.17M rows a day, inside the design C budget (`durable-object-cost.md`). Recorded days therefore already hold every active code's book, not only the watched ones.
- **What a scanner adds in the object**, if the readings are computed there: one pass over each changed book each tick, about 25–40 books × 40 levels. That is microseconds to low milliseconds a tick, small next to decoding. This is an estimate, not a measurement.
- **What a larger Ajaib N adds**: N subscribe messages on each open, and N rows written a minute for the whole-book store. For N = 900, that is about 0.3M rows a day and about 6.8M a month, which costs $0–7 a month over the included 50M. Each `ORDER_BOOK_CUSTOM` frame is a JSON parse plus a map update.

## 6. Cost on the viewer socket

This is already paid today too, and it is the largest cost.

- Each delta carries **every order book that changed, of any code**, to every ready viewer (`sendDelta`; **Delta** in `packages/relay/GLOSSARY.md`). The page keeps only its selected code's (`order-book-store.ts`, `heatmap-store.ts`: `message.orderBooks?.find(...)`).
- A served book is the whole 20-level book, not the change: about 40 levels × about 40 bytes of JSON, plus a header, about **1.7–1.9 KB** a code. Thinner codes are smaller.
- At about 100–150 changed books a second in Session 2, that is an **estimated 150–270 KB/s per viewer**. At the open, with about 300 a second, it is about **0.5 MB/s**. These figures are arithmetic from the frame rates, not measured on the socket.
- **Compression.** The deploy's compatibility date is `2026-11-02` (`packages/deploy/src/target.ts`). The `web_socket_compression` flag has been on by default since 2023-08-15, so the runtime "is capable of using WebSocket Compression on both inbound and outbound WebSocket connections" ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)). Browsers offer `permessage-deflate`, so the viewer socket probably negotiates it, and repetitive book JSON compresses well. This is **not verified** on a hibernated Durable Object socket.
- Outgoing WebSocket messages are free on Durable Objects (`durable-object-cost.md`). The cost lands on the viewer's bandwidth, the browser's `JSON.parse` of each delta, and phones on mobile data.

**What this means for the radar.** A scanner fed from the delta needs no protocol change, because every book already arrives. But it inherits the full whole-book stream. If the object computes the readings, it can send a compact per-code reading (a few numbers, about 100 bytes) instead. That would let the delta drop whole books for codes the viewer did not select, cutting the viewer's book bytes about 15–20 times. Tickets that decide where the readings are computed (#490, #491) should weigh this.

## 7. Open risks

1. **The 09:00 open.** The full-load Stockbit socket dropped at 09:00:02, and the relay's event queue collapsed after a burst on 2026-11-12 (`relay-event-queue-clamp/README.md`, fixed with `disableYield` in `service-worker.ts`, [#229](https://github.com/apinrdw/kumora/issues/229)). The radar is busiest when the open is busiest, so expect a gap in the first seconds.
2. **Ajaib fallback coverage.** When Stockbit is stale, only on-demand codes have an Ajaib book. A whole-market scanner then goes blank for every other code unless Ajaib's N grows to hundreds, which is untested. Plan for the scanner to say it is waiting on Stockbit.
3. **Viewer bandwidth** on phones. See §6.
4. **Stale books.** A code with no frame keeps its last book. A quiet code's book can be many minutes old, so the scanner needs to show each code's as-of.
5. **Per-code rates are estimates.** See the follow-up below.

## Follow-up measurements

1. **Per-code book cadence and viewer bytes, from a sealed day.** With a session cookie (`docs/agents/production-reads.md`), read one sealed day's book chunks for the whole market at 09:00–09:05 and in a Session 2 hour. Count deltas per code per minute (`servedAt`), the distribution across codes, and the encoded size of a whole served book. This replaces the estimates in §4 and §6 without a live probe.
2. **Viewer socket on the wire, live.** In Market Live's DevTools during Session 2 and at 09:00, check that `Sec-WebSocket-Extensions` negotiated `permessage-deflate`, and record bytes a second on the viewer socket.
3. **Ajaib at N in the hundreds.** In one Session 2 window, subscribe `ORDER_BOOK_CUSTOM` for 100, then 300 codes on a test socket. Record whether each code gets an `is_initial` book, the frames and bytes a second, and any close or error. Do this only if the radar needs a whole-market fallback.

## Confidence

| Claim                                               | Basis                                                                  | Confidence                              |
| --------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| Stockbit books are subscribed for every listed code | Code: `subscribeFrame`, `makeStockbitSubscriptions(codeList.codes, …)` | High                                    |
| Every changed book goes to every viewer             | Code: `sendDelta`, `takeChanged`; relay glossary **Delta**             | High                                    |
| Book chunks are recorded for every served code      | Code: `bookChunks.record` in `sendDelta`                               | High                                    |
| Stockbit frame rates by channel                     | Probe captures from 2026-11-06 and 2026-11-09                          | High for Session 2, medium for the open |
| Per-code cadence                                    | Three anchors, no per-code counts                                      | Low (estimate)                          |
| Viewer bytes a second                               | Arithmetic on frame rates and book size                                | Low (estimate)                          |
| Ajaib limit for N in the hundreds                   | No data                                                                | None                                    |
