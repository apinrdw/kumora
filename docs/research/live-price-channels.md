# Which live price and order book channels Stockbit and Ajaib offer, and whether they take `*`

Research for [#52](https://github.com/apinrdw/kumora/issues/52), under the Market Live map [#38](https://github.com/apinrdw/kumora/issues/38). Read on 2026-11-06. It builds on [`stockbit-live-data.md`](https://github.com/apinrdw/kumora/blob/research/stockbit-live-data/docs/research/stockbit-live-data.md) (#39) and [`ajaib-live-data.md`](https://github.com/apinrdw/kumora/blob/research/ajaib-live-data/docs/research/ajaib-live-data.md) (#40) and does not repeat them.

Nobody signed in for this. Every claim comes from shipped client code, from open-source code at a pinned commit, or from frames that a third party captured and committed. Claims marked **confirm** need the owner's DevTools check.

## Verdict

**Stockbit:** the v1 `liveprice` message carries everything a watchlist row needs: last, previous close, change and change %, value, volume, lots and frequency. But nothing shows that `liveprice: ["*"]` works. Stockbit's own web app always subscribes `liveprice` with explicit stock codes, and its listeners drop any frame whose `stock_code` is not in that list. The two open-source projects that send `watchlist: ["*"]` have no decoder for the `watchlist` reply, and one of them states that `*` is valid only for `running_trade_batch`. The web app never sends `watchlist`, `liveprice_v3` or `order_book_v3` at all.

**Ajaib:** the web app sends `PRICE` one stock code per `SUBSCRIBE`, and it never sends `streamObject: "*"` for `PRICE`. A 2023 open-source script did send `PRICE` with `*`, but it only printed the replies and recorded nothing. The fields the client reads from a `PRICE` frame do not include value, frequency or previous close.

**Plan for the watchlist:** one `liveprice` subscribe that lists every watchlist code, sent in the cumulative channel message, using the codes the owner keeps. That is the path the web app itself uses. Whether `*` works on either site is a DevTools question (see the last section).

**Order book:** neither site's client subscribes an order book with `*`. Both clients subscribe per code. A whole-market book would be heavy: about 1 KB per side snapshot and 1.4 to 2.5 frames/s for one active code. Subscribe the selected stock code only.

## Sources

| Tag           | Source                                                                                                                                                    | Pinned at                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **[sb]**      | stockbit.com Next.js bundle, `buildId` `v3.54.12`, fetched anonymously. All 647 chunks from `_buildManifest.js` plus the webpack runtime's lazy-chunk map | chunk names below, 2026-11-06              |
| **[aj]**      | trade.ajaib.co.id Vite bundle, entry `index-CYGRWyZA.js`, 140 chunks crawled from the entry                                                               | chunk names below, 2026-11-06              |
| **[haka]**    | [`nofendian17/stockbit-haka-haki`](https://github.com/nofendian17/stockbit-haka-haki)                                                                     | `18fe1e9ccd6b5437ad4e84a23decc08c75e4bad8` |
| **[axiom]**   | [`chairulridjaal/axiom-feed`](https://github.com/chairulridjaal/axiom-feed)                                                                               | `ec7447aba8ab44e1363e667964a05624be622bb3` |
| **[ofs]**     | [`silenccy/orderflow-station`](https://github.com/silenccy/orderflow-station)                                                                             | `39f4410ea0702bb5209f7a765e6b8e1f5e490173` |
| **[lot]**     | [`r3ven7/lot`](https://github.com/r3ven7/lot), with committed CDP captures of Stockbit frames from 2026-04-17                                             | `1a66f4c68a83b2764d3ee66770b98848e1334857` |
| **[wina]**    | [`aa-ardanirahman/wina_idx`](https://github.com/aa-ardanirahman/wina_idx)                                                                                 | `40369094a15b4c8fd250e6dfbf519f4ee4f9e4dc` |
| **[proxyai]** | [`azdharsyahputra/proxyai`](https://github.com/azdharsyahputra/proxyai)                                                                                   | `a39ff4462b3e953231cbd6472f6a8a6e3db7db2b` |

The GitHub code search also returned `kevindoni/hakahaki`, `oyi77/1ai-nexus` and `aryarifki/Mapping`. None of them subscribes a price, watchlist or order-book channel.

## 1. Stockbit message fields

All of these come from **[sb]** `20793-dcf9c3587c81dd92.js` (protobuf-es descriptors). Scalar types: `double` unless noted. `DecimalValue` is `{ raw: google.type.Decimal { value: string }, formatted: string }`.

The request side, `WebsocketChannel`, holds `repeated string` stock codes per channel: 1 `watchlist`, 2 `order_book`, 6 `liveprice`, 9 `best_bid_offer`, 12 `liveprice_v3`, 13 `order_book_v3`. The reply wrapper `WebsocketWrapMessageChannel` is a `oneof`, so **each frame carries one message for one stock code**. Only `running_trade_batch` is a batch.

### `liveprice` (request 6) → reply case 9, `consumer.entity.v1.LivePrice`

| #     | Field                                                              | Type                                                                               | Watchlist use                            |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| 1     | `stock_code`                                                       | string                                                                             | code                                     |
| 2     | `lastprice`                                                        | double                                                                             | **last**                                 |
| 3     | `volume`                                                           | double                                                                             | **volume** (shares or lots: **confirm**) |
| 4     | `high`                                                             | double                                                                             |                                          |
| 5     | `low`                                                              | double                                                                             |                                          |
| 6     | `open`                                                             | double                                                                             |                                          |
| 7     | `frequency`                                                        | double                                                                             | **frequency**                            |
| 8     | `frg_buy`                                                          | double                                                                             | foreign buy                              |
| 9     | `frg_sell`                                                         | double                                                                             | foreign sell                             |
| 10    | `average`                                                          | double                                                                             |                                          |
| 11    | `date`                                                             | string                                                                             |                                          |
| 12    | `close`                                                            | double                                                                             |                                          |
| 13    | `prev`                                                             | double                                                                             | **previous close**                       |
| 14    | `value`                                                            | double                                                                             | **value**                                |
| 15    | `change`                                                           | `Change { value, percentage }`                                                     | **change**, change %                     |
| 16    | `order_verb`                                                       | string                                                                             |                                          |
| 17    | `quantity`                                                         | int64                                                                              |                                          |
| 18    | `is_index`                                                         | bool                                                                               | marks indices                            |
| 19–22 | `sequence_number`, `order_book_id`, `order_number`, `match_number` | int64                                                                              |                                          |
| 23    | `board`                                                            | enum RG / TN / NG                                                                  |                                          |
| 24    | `source`                                                           | enum ITCH / IMQ / CRYPTO                                                           |                                          |
| 25    | `switch_reset`                                                     | `SwitchReset { from, to, reason, datetime }`                                       |                                          |
| 26    | `itch_incoming_time`                                               | string                                                                             |                                          |
| 27    | `trade_trigger`                                                    | `TradeTrigger { stock_code, quantity, execution_price, value, volume, timestamp }` | the trade that caused the update         |
| 28    | `lot`                                                              | double                                                                             | **lots**                                 |

The web app's mapper (**[sb]** `24631.cfd1cf1ad2f92202.js`, export `XA`) reads `prev, change.value, change.percentage, frequency, open, high, low, lot, volume, value, average, close, lastprice, date, stockCode`. That is the set the UI trusts. `volume` and `lot` both exist, so `volume` is probably shares. **Confirm.**

### `liveprice_v3` (request 12) → reply case 16, `consumer.entity.v3.LivePrice`

1 `symbol` (string), then `DecimalValue` fields: 2 `lastprice`, 3 `volume`, 4 `high`, 5 `low`, 6 `open`, 7 `average`, 9 `close`, 10 `previous`, 11 `value`, 12 `change`, 13 `change_percentage`, 17 `frequency`, 18 `quantity`. The rest: 8 `date` (string), 14 `board`, 15 `source`, 16 `timestamp` (`google.protobuf.Timestamp`). It has no `lot` and no foreign flow. No chunk in **[sb]** other than the schema refers to `livepriceV3`, so the web app does not use it today.

### `watchlist` (request 1) → reply case 4, `datafeed.v1.Watchlist`

1 `stock_symbol` (string), 2 `last_price` (double), 3 `change` (`Change { value, percentage }`). That is all. It has **no previous close, value, volume or frequency**, so it cannot feed a watchlist row even if `*` works. No chunk in **[sb]** sends the `watchlist` channel.

### Order book messages

| Channel              | Reply                                          | Fields                                                                                                                                                                             |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order_book` (2)     | case 10 `consumer.entity.v1.Orderbook`         | 1 `stock_code`, 2 `body` (string), 3 `sequence_number`, 4 `order_book_id`, 5 `datetime` (string), 6 `source`, 7 `switch_reset`, 8 `board`, 9 `itch_incoming_time`                  |
| (legacy)             | case 5 `OrderBookHeader`                       | 1 `stock_symbol`, 2 `change`, 3 `price` = `Price { open, high, low, avg, last, prev, frequency, fbuy, fsell, lot, val }`, 4 `time`                                                 |
| (legacy)             | case 6 `OrderBookBody`                         | 1 `stock_symbol`, 2 `bid[]`, 3 `offer[]` (each `{ price, lot }`), 4 `time`                                                                                                         |
| `order_book_v3` (13) | case 17 `consumer.entity.v3.Orderbook`         | 1 `symbol`, 2 `bid[]`, 3 `offer[]`, 4 `total_bid`, 5 `total_offer` (each `OrderBookData { volume, price, frequency }` as `DecimalValue`), 6 `timestamp`                            |
| `best_bid_offer` (9) | case 13 `company_price_feed.v1.BestBidOfferWS` | 1 `stock_code`, 2 `sequence_number`, 3 `best_bid`, 4 `best_offer` (each `BestOrder { price, quantity: Value { raw: float, formatted }, change_percentage: string }`), 5 `datetime` |

The v1 `body` is pipe-delimited text. The web parser (**[sb]** `62534.14089f78aa4b9305.js`, module `27886`, `parseSocketString`) reads `#O|SYM|BID` or `#O|SYM|OFFER`, then `price;queue;volume` levels. **[ofs]** `docs/protocol.md` reports the same live: one side per frame as a full snapshot, the middle field as the resting order count, volume in shares, and about 60 levels.

The web app uses only `order_book` (v1) and `best_bid_offer`. `orderBookV3`, `orderbookHeader` and `orderbookBody` appear nowhere outside the schema. **[haka]** and **[axiom]** decode case 6 `OrderBookBody`, but neither shows that the server still sends it.

## 2. Does anything subscribe a Stockbit price, watchlist or book channel with `*`?

**The Stockbit web app does not.**

- The only `["*"]` literals in all 647 chunks are the running-trade widget's `AllStock` default and the "All Stocks" filter. That is `running_trade_batch`.
- `liveprice` codes come from a per-instance store, `setLivePriceSymbols(instance, codes)` (**[sb]** `24631-…` module `4282`, store module `36577`). The socket module (**[sb]** `9293.5f722a92ed0608ae.js`, module `5386`) merges the stores into one cumulative `WebsocketChannel` and resends it, debounced by 100 ms. Order books work the same way through `setOrderbookSymbols`.
- Every `liveprice` and `orderbook` listener filters with `codes.split(",").includes(frame.stockCode)` (module `32041` and the `79024` order-book hooks). Even if the server honoured `*`, the web app's own code would drop every frame. That is evidence that the web app never relies on a `*` price stream.
- `best_bid_offer` is sent as a de-duplicated code list (**[sb]** `48891.91bad4c266b056b6.js`, `73503-05fe03fd753668fa.js`).

**Open source:**

| Repo                                                                                   | Sends                                                                                                               | What it does with the reply                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[haka]** `websocket/client.go`                                                       | `RunningTradeBatch: ["*"], Watchlist: ["*"]`                                                                        | Its `proto/datafeed.proto` wrapper has no `watchlist` case (only 1, 2, 6, 8, 9, 10). `handlers/running_trade.go` returns `unknown message channel type` for anything else. It drops `orderbook` case 10 by its first byte. It never processes a watchlist reply.          |
| **[axiom]** `services/ingest-rs/src/feed.rs`, `services/api-py/.../embedded_ingest.py` | `running_trade_batch: ["*"]`, `watchlist: ["*"]`, and `liveprice` / `order_book` with **explicit** codes            | `feed.rs` asserts `"wildcard only for trades/watchlist"`. `docs/ARCHITECTURE.md` states that `"*"` is only valid for `running_trade_batch` and rejects `*` for quotes and books with a 400. Its wrapper proto is copied from **[haka]**, also without a `watchlist` case. |
| **[ofs]** `orderflow/feed.py`                                                          | One captured web subscribe frame, re-targeted per code (`order_book`, `running_trade_batch`, `liveprice`, `iepiev`) | Never sends `*`.                                                                                                                                                                                                                                                          |

So `watchlist: ["*"]` appears in two repos, but no repo shows what it returns. No repo sends `liveprice: ["*"]`.

## 3. Ajaib `PRICE`

### Frame fields

The `PRICE` hook (**[aj]** `price-ws-DLfW6eKV.js`) opens `wsUrl("price")` and sends `{method, id, stream: "PRICE", streamObject: <code>}`. It reference-counts each code in a `tickerCounter` map. On reconnect it resubscribes each counted code, one frame per code. Its consumers read these fields:

| Field                       | Read by                                                                                                         | Meaning                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ticker`                    | all consumers                                                                                                   | stock code                                                                                |
| `price`                     | all                                                                                                             | last                                                                                      |
| `change`                    | `useStockPriceWs-CUiK06W8.js`, `fetch-CBAwHG3Q.js`, list hook `lne` in `index-*.js`                             | change in rupiah                                                                          |
| `pctChange`                 | same                                                                                                            | change %. The list hook's guard `yE` requires `ticker`, `price`, `change` and `pctChange` |
| `open`, `hi`, `lo`, `close` | `useStockPriceWs`, `fetch-CBAwHG3Q.js` (stored as `ws_open`, `ws_hi`, `ws_lo`, `ws_close`), `Chart-BiAa0fN8.js` | day OHLC. Whether `close` is the previous close or the current close: **confirm**         |
| `tradableVolume`            | `Chart-BiAa0fN8.js`                                                                                             | cumulative day volume. The chart takes the per-bar volume as the change in it             |
| `updateTime`                | all                                                                                                             | epoch ms                                                                                  |

No consumer reads value, frequency or a named previous close. Previous close can be derived as `price - change`. Value and frequency would have to come from REST (`v1/stock/detail/{CODE}/price/`) unless the frame carries more fields than the client reads. **Confirm.**

### Wildcard

- The only `*` subscriptions in the 140 Ajaib chunks are `TRADE:*` (`QC.subscribe("TRADE:*")` in `index-*.js`). `PRICE` is always one code per frame. The list hook `lne` sends one `SUBSCRIBE` per code for a whole list.
- **[wina]** `brokers/ajaib/running_trade.py` (2023-01-19) sent `{"stream":"PRICE","streamObject":"*"}` to `wss://stream.ajaib.co.id:8009/ws/price`. It only prints the replies, and it records no output. The server may have accepted it in 2023. Nothing shows that it still does.
- `fetch-CBAwHG3Q.js` holds the REST watchlist route (`v2/watchlist-center/watchlist`) next to a single-code `PRICE` hook. I did not trace which hook the watchlist rows use, but every `PRICE` hook in the bundle is per code. `__ENV.js` defines `VITE_PUBLIC_WATCHLIST_WEBSOCKET` (`wss://realtime.ajaib.co.id`), but no chunk reads it.

## 4. Order book

### Stockbit

The fields are in section 1. The web app subscribes `order_book` per code and decodes the v1 text `body`. Nobody subscribes `order_book`, `order_book_v3` or `best_bid_offer` with `*`. **[axiom]** forbids it outright.

**Payload size and rate**, measured from the **[lot]** CDP captures with a script that reads frame headers only:

| Capture                                   | Codes       | Duration | Book frames (case 10) | Bytes per frame      | Levels per frame | `liveprice` (case 9) |
| ----------------------------------------- | ----------- | -------- | --------------------- | -------------------- | ---------------- | -------------------- |
| `orderbook_subscribe_raw_20260417_135958` | PTRO        | 46 s     | 2.5/s                 | avg 790, max 897     | avg 44, max 50   | 1.0/s, about 220 B   |
| `…_140155`                                | PTRO, BBRI  | 58 s     | 1.4/s                 | avg 884, max 1,430   | avg 49, max 84   | 0.4/s                |
| `…_142448`                                | mostly BBRI | 34 s     | 2.3/s                 | avg 1,104, max 1,431 | avg 62, max 84   | 0.5/s                |

A whole-market book, if `*` were accepted, would be roughly a few hundred active codes × 1–2.5 side snapshots/s × about 1 KB. That is **on the order of 0.3–1 MB/s of text to split and parse, more at the open and close**. This is an extrapolation, not a measurement. A whole-market `liveprice` would be much lighter: one about 220-byte frame per update, at most on the order of the trade rate (the #38 map records a measured Stockbit peak of 263 trades/s), so roughly 15–60 KB/s.

### Ajaib

The order book has two streams, each on its own socket path from `wsUrl()` (**[aj]** `index-*.js`):

| Stream              | Path                    | When used                                         | Frame                                                                                                                                                                                                      |
| ------------------- | ----------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDER_BOOK_CUSTOM` | `/ws/order-book-custom` | default                                           | `{ ticker, updateTime, buy: [level], sell: [level] }`, applied as **deltas** to the REST `v1/stock/bestquote/?code=&extended=true` snapshot. A level with `lot` 0 deletes that price. Batched every 150 ms |
| `ORDER_BOOK_FULL`   | `/ws/order-book-full`   | when the `desktop_fast_trade_zero_lot` flag is on | the same shape plus `is_initial` / `isInitial`. An initial frame replaces the book, and later frames merge by price. Seeded from REST `v1/stock/data/orderbook/full?code=`. Batched every 50 ms            |

A `level` is `{ price, lot, num }`, where `num` is the order count (the UI maps it to `bidFreq` and `askFreq`). Both streams subscribe one code, `streamObject: <code>`, with a 500 ms delay. **[proxyai]** `go-proxy/debug/debug_ws.go` also subscribes `ORDER_BOOK_CUSTOM` with `BBCA`, through `wss://trade.ajaib.co.id/ws/stock/order-book-custom`. Nothing sends `*`. Ajaib's book is a delta stream, so a whole-market subscription would be lighter per update than Stockbit's snapshots. It would still need one REST snapshot per code before any delta means anything, so it does not work as a whole-market feed.

The string `ORDERBOOK` in `stock.store-*.js` is a panel enum, not a stream.

## 5. What the owner must confirm in DevTools

Sign in, open the site during market hours, and use Network → WS → Messages. Remove tokens, keys and the account id from anything you copy.

**Stockbit** (`wss-jkt.trading.stockbit.com/ws`; decode the frames with the schema in `20793-*.js`):

1. Open a watchlist page and confirm that the outbound `WebsocketChannel` lists the codes in `liveprice` (field 6) and that `watchlist` (field 1) is empty.
2. From the console, send the page's own last channel message again with `liveprice: ["*"]` added, using the same `key`, `user_id` and `access_token`. Check whether case-9 frames start arriving for codes not on the page, an `error` (case 7) comes back, or nothing happens. Do the same with `watchlist: ["*"]` and look for case-4 frames. Then send the original message again to restore the page.
3. On one case-9 frame, compare `volume` with `lot` (shares and lots?), and `prev`, `value` and `frequency` with the UI.
4. Check whether `liveprice` sends a frame on every trade or on a timer (count frames per code against the tape).
5. For the order book: confirm that the selected code's book arrives as case 10 with a text `body`, not as 6 or 17. If you test `order_book: ["*"]`, note the frame rate and bytes per second before you restore the page.

**Ajaib** (`/ws/price`, plus `/ws/order-book-custom` or `/ws/order-book-full`):

6. On a stock page, copy one inbound `PRICE` frame and list every key. Check for value, frequency and previous close, and whether `close` is the previous close.
7. On the price socket, send `{"method":"SUBSCRIBE","id":<id>,"stream":"PRICE","streamObject":"*"}`. Check whether frames arrive for other codes, and how fast. Then send `UNSUBSCRIBE`.
8. Check which order book path the tab opens (custom or full), and copy one frame to confirm `{ ticker, updateTime, buy, sell }` with `{ price, lot, num }` levels.
