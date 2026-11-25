# Which post-close route gives each trade's buy and sell order numbers with its trade number

Research for [#617](https://github.com/apinrdw/kumora/issues/617), under the map [#616](https://github.com/apinrdw/kumora/issues/616). Read on 2026-11-20. It builds on [`ajaib-post-close-broker-codes.md`](https://github.com/apinrdw/kumora/blob/research/ajaib-post-close-broker-codes/docs/research/ajaib-post-close-broker-codes.md) (#125), [`stockbit-post-close-broker-codes.md`](https://github.com/apinrdw/kumora/blob/research/stockbit-post-close-broker-codes/docs/research/stockbit-post-close-broker-codes.md) (#124), [`stockbit-live-data.md`](stockbit-live-data.md), [`live-price-channels.md`](live-price-channels.md) and [`rest-tape-backfill.md`](rest-tape-backfill.md). It does not repeat their auth, paging-cost and start-time findings.

## Answer

**Stockbit's `order-trade/running-trade` is the route.** Each row carries `trade_number`, `buy_order_number`, `sell_order_number` and `group_order_number` side by side, so no join is needed. The Stockbit walk already pages every trade of the newest closed day after Ajaib's walk, and it already decodes `trade_number`. Keeping the order numbers means reading two more fields from the rows it already fetches. The open questions are about values, not about the route: whether the numbers are filled on the walk's whole-market `date=` call after the close, and what they number. During the session every captured row has `"0"` for all three.

**Ajaib's `running_trades/` has no order number.** Neither the bundle nor any captured row shows one. The walk drops nothing.

**Ajaib's Done Details `broker-transaction` with `type=TRADE` does carry both order numbers**, which corrects #125: its rows have `buyer.order_id` and `seller.order_id` on `TRADE` as well as `ORDER`. But a row has no trade number, and the route is per stock code. Joining it to a **Trade number** means matching code, board, second, price, lots and both broker codes. Trades that tie on all of these can't be told apart, but they are interchangeable for a sweep, so the tie costs nothing for the regroup. It is the fallback if Stockbit's numbers turn out empty or unusable. It costs about one call per traded code plus rows / `page_size`.

**An IDX order number**, from IDX's trading engine (JATS-NextG on Nasdaq X-stream INET): in Nasdaq's INET ITCH, an Order ID is "only unique per Order book and side", and each match gets its own Match ID. An order book is one instrument on one board. So an order number is not exchange-wide, and it is not per broker. Two orders of the same code and side never share a number. Whether the numbers count up densely per order book, and whether they reset daily, is not public, and the brokers' numbers may be their own re-keying of it. These are live checks 1–4.

## Sources

| Tag | Source | Version |
|---|---|---|
| **[aj]** | trade.ajaib.co.id Vite bundle, entry `index-DtbLOxDx.js` and the 158 chunks reachable from it, fetched anonymously | 2026-11-20. The entry hash changed since #125 (`index-DKOtYJk3.js`). Search for the quoted string literals, not the minified names |
| **[sb]** | stockbit.com Next.js bundle, `buildId` `v3.57.0`, 329 page, shared and lazy chunks, fetched anonymously with a browser User-Agent. Four lazy chunks answered 403 | 2026-11-20. The running-trade chunk is now `18430-aa4454a2542eba50.js` (#124 read `18430-d9c187f91165df68.js`) |
| **[cap]** | The owner's signed-in REST captures `kumora-probe-stockbit-*` (2026-11-06 and 2026-11-09, 09:41–16:04 WIB) and `kumora-probe-ajaib-*` (same days), and the repo fixture built from them, `apps/dashboard/tests/server/market-live/fixtures/rest-running-trades-2026-11-09.json` | local files, read only |
| **[mcp]** | [`INo-xious/stockbit-mcp`](https://github.com/INo-xious/stockbit-mcp) `src/live/attribution.ts`, `src/core/market.ts`, `test/livesignals.test.ts` | `b5c23760f5552316792bcb3abeb1a2d01c817ffa` |
| **[itch]** | Nasdaq, *Genium INET ITCH 2.0 Protocol Specification*, rev. 2.12, [nasdaqtrader.com](https://www.nasdaqtrader.com/content/nfx/ITCHRefDataGuideNFXv2_00.pdf), sections Add Order and Order Executed | 2015-04-09 |
| **[jats]** | Kontan, ["Menilik rencana pembaruan sistem JATS BEI di 2026"](https://investasi.kontan.co.id/news/menilik-rencana-pembaruan-sistem-jats-bei-di-2026); Nasdaq press release, ["Indonesia Stock Exchange Partners with Nasdaq to Upgrade Market Infrastructure"](https://www.nasdaq.com/press-release/indonesia-stock-exchange-partners-nasdaq-upgrade-market-infrastructure-2024-06-17) | 2025; 2024-06-17 |

The bundles show what the web apps send and read, not what the servers fill in. **[itch]** is Nasdaq's spec for its INET family. IDX publishes no ITCH spec, so applying **[itch]** to IDX is **inferred** from **[jats]**, which says IDX runs X-stream INET under a Nasdaq licence. **[mcp]** is second-hand, and its one sample row has unknown provenance.

## 1. Ajaib `v1/stock/detail/running_trades/`

- **No order-number field.** All 320 REST rows in the **[cap]** Ajaib captures have exactly `stock_code`, `trade_num`, `lot`, `price`, `side`, `time`, `date`, `buyer`, `seller`, `buyer_type`, `seller_type`, `buyer_color`, `seller_color`, `return_pct`, `market_type` and `timestamp`.
- The bundle's running-trade code (**[aj]**, `"/v1/stock/detail/running_trades/"` and the per-code `"/v1/stock/detail/${e}/running_trades/"`) reads no order field either.
- All the captures were taken during the session or right at 16:04. A post-close row could in principle carry more fields than these. Live check 5 settles it. Nothing in the bundle suggests it does.

## 2. Ajaib Done Details `v1/stock/data/broker-transaction`

### The call

```
GET v1/stock/data/broker-transaction
  ?code=<CODE>&group=BS&type=TRADE&market_date=<YYYY-MM-DD>
  [&start_time=HH:mm:ss&end_time=HH:mm:ss&market_type=RG|NG|TN&broker_code=&price=]
  [&cursor=<result.next_cursor>]
```

- The hook (**[aj]** `hZ="v1/stock/data/broker-transaction"`, `yZ`) needs `code` and `group`. It sends `cursor` from `pageParam` (first page `null`). It pages while `result.has_next`, using `result.next_cursor` (`xZ`). The web app never sends `page` or `page_size`.
- The owner's URL sends `page=2&page_size=1000` and works, so the server also takes offset paging. That path is not in the bundle. Its cap, and whether it ignores `cursor`, are **live check 6**.
- The app drops `start_time`/`end_time` when they are its defaults `09:00:00`–`16:00:00`, so the server applies its own default window. The owner's `00:00`–`23:59:59` makes sure the pre-opening and post-closing trades are included. Whether the server default already covers them is also part of live check 6.
- The app refuses today's date while `trading-day/time/` `status !== "CLOSED"` (`isStillMarketTime`), as #125 found.

### Row fields on `type=TRADE`

The app runs the same table columns (`D("TRADE")` and `D("ORDER")`) over `result.transactions[]` for both types (**[aj]** `VZ`):

| Field | Read by |
|---|---|
| `time` | column `WAKTU`, `HH:mm:ss`, or `HH:mm` padded to `:00` (`RZ`) |
| `price`, `qty` | columns `PRICE (Rp)` and `QTY`. The detail dialog shows `qty` as `Lot`, and its total is `price * qty * 100`, so `qty` is in lots |
| `buyer`, `seller` | objects with `broker_code`, `type` (domestic/foreign label) and `order_id` |
| `code`, `board` | only in the row key `UZ` (`` `${code}:${board}:${time}:${price}:${buyer?.order_id}:${seller?.order_id}` ``). The bundle never renders them, so whether the server sends them is **live check 7** |

**`order_id` is on TRADE rows.** Clicking a TRADE row's buyer or seller badge stores `{type:"TRADE", side, item, market_date, code, group, order_id: <badge>.order_id}`. The dialog `oQ` (title `"Detail Transaksi"`) then calls `v1/stock/data/broker-transaction/detail` with `{order_id, type, group, market_date, code, side}` (**[aj]** `_Z`, `bZ`, enabled only when `order_id` is set). The dialog lists that order's matches under `"Rincian Order Matched"`, with `total_amount` and `total_qty`, and the note "Transaksi ini terjadi karena ada transaksi yang matched dengan Buyer/Seller di atas". So each side's `order_id` names the order that side traded from, and `/detail` lists every trade of that order. #125 said `order_id` appears only on `type=ORDER`. That was wrong.

The row has **no trade number** and **no aggressor side**. #125 found this from the bundle. The column set above confirms it.

### Joining a row to a trade number

The day's trades from either walk carry trade number, time (to the second), code, price, lots, board and both broker codes. A Done Details row matches a trade on the key **(code, board, second, price, lots, buyer code, seller code)**.

- **Ties.** Several trades in one second can share every field of the key. A large aggressor order filling several 1-lot resting orders of one broker at one price is the common case. The key can't tell them apart.
- **Why a tie doesn't matter for the regroup.** Tied trades are identical in everything a sweep reads: second, price, lots, both brokers. Hand the tied rows' `(buy order_id, sell order_id)` pairs to the tied trade numbers in any order. Each order then gets the same trades, and so the same lots, price and second. Every order-grouped sweep comes out the same. Only the per-trade-number record of which order number belongs to which trade number is arbitrary within a tie.
- **When the counts differ.** A key with n trades on one side and m ≠ n rows on the other is a real mismatch: a missed page, a board the row doesn't carry, or a different `qty` unit. Leave that key's trades without order numbers.
- **Row order** within a second may follow trade-number order, which would turn the tie handling into an exact join. **Live check 8.**

### Cost

One cursor or offset chain per traded code: about 900 codes a day (estimated in #124, not measured), plus rows / `page_size` calls. At `page_size=1000` that is roughly 1,300–2,200 calls of rows plus about 900 first calls, so 2,200–3,100 calls a day. The chains are independent and can run in parallel. That is comparable to Ajaib's whole-market walk at large page sizes, but it is a second full fetch of the day on top of the walk that brings the trade numbers.

## 3. Stockbit `order-trade/running-trade`

### The fields

**[cap]**: every Stockbit REST row has `buy_order_number`, `sell_order_number` and `group_order_number`, as strings, beside `trade_number`, `action`, `buyer`, `seller`, `market_board` and the rest. In all 520 rows captured during the session (2026-11-06 09:41–14:05 WIB), all three are `"0"`, the same session-time blanking as `buyer`/`seller` and `is_broker_exists: false`. The 2026-11-09 16:04 capture holds no REST rows.

**[mcp]** read the fields off the live endpoint "on a CLOSED market" (2026-08-28) and keeps a sample row: `trade 08:58:00 ZONE buy 2 lots, buyer "KK [D]", seller "XL [D]", buy_order_number "27642", sell_order_number "12532"`. The values are small, so they look like a per-order-book count, not a 64-bit exchange ID. That is one row of unknown origin.

### What they mean, from the bundle

The table never renders the three fields. It uses them only in the **Merge Order ID** feature (**[sb]** `18430-aa4454a2542eba50.js`):

- A "Merge Order ID" switch opens a **"Running Trade (Merged)"** modal. It shows only when `!isOpenMarket` and exactly one stock is selected. Merging by order is a post-close feature, like the broker codes.
- The modal pages `GET /order-trade/running-trade/group` (`getRunningTradeGroup`, query key `"running-trade-group"`) with `limit: 50` and a `cursor` set to the last group's `id`. The response has `running_trade_group[]` and a `single_order` flag. A group has `time`, `price{formatted}`, `change`, `action`, `lot`, `value`, `market_board`, `trade_number`, `order_number`, `group_action`, and `buyer`/`seller` as arrays of `{broker_code, broker_type}`.
- Clicking a group filters the plain tape to it: `order_number = group.order_number` and `group_action = single_order ? group.action : group.group_action`, with every other filter cleared. So the tape route takes `order_number` + `group_action` as a filter for "the trades of this order".
- The matcher `I(row, group, single_order)` decides which tape rows belong to a group:
  - with `single_order`: `group.order_number === row.group_order_number`, same price, and same `action`;
  - otherwise: `group.order_number === row[group.group_action === BUY ? "buy_order_number" : "sell_order_number"]`, same price.
- **So:** `buy_order_number` and `sell_order_number` are the numbers of the buy-side and sell-side orders that a trade matched. They are in the same number space as the grouped route's `order_number`. `group_order_number` is the order a trade is merged under when `single_order` holds. With `action` as the aggressor side, that is most likely the aggressor's order, which would make `group_order_number` the regroup key directly (**inferred**, live check 3).
- A group also matches on **price**. Stockbit's merged row is one order at one price, so an order that sweeps three price levels shows as three groups. Kumora's rule groups by order and second, not by price, so it should take the per-trade numbers, not the grouped route.

### Whether the walk can just keep them

Yes, if live check 1 passes. `stockbit-walk.ts` decodes each row with `RowNumber` (`trade_number`), `stockbitRowCodes` and `stockbitRowFields`. `StockbitRow` in `packages/relay/src/broker-codes.ts` would add `buy_order_number` and `sell_order_number` (and `group_order_number` if check 3 shows it is the aggressor's). The walk already:

- runs on the newest closed day after Ajaib's walk, as the cross-check, and on any day Ajaib can't serve;
- pages the whole market with `date=<day>`, 100 rows a call, every board. A full day took 64 min at 3 calls/s (#127);
- gap-walks older incomplete days.

What it costs: the order numbers would come only from Stockbit, so a day with no Stockbit walk (the tab signed out, or Stockbit giving the day up as `no-rows`) has none. The batch also has to carry them, a `BrokerCodesProtocolVersion` bump. Both are spec questions for #616, not route questions.

## What an IDX order number is

- **The engine.** IDX runs JATS-NextG with the X-stream INET trading application, licensed from Nasdaq. A Nasdaq matching-engine upgrade (JATS MME) is planned for 2026 (**[jats]**). The Stockbit price channel's `source` enum names `ITCH`, and its message has `order_book_id`, `order_number` and `match_number` (int64) and `itch_incoming_time` (`live-price-channels.md`, **[sb]** `20793-f758910ccde2e3dc.js`). So the brokers' data comes from IDX's ITCH feed.
- **Nasdaq INET ITCH** (**[itch]**, Add Order and Order Executed): "Order ID … The identifier assigned to the new order. Note that the number is only unique per Order book and side." Also: "the same Order ID may be present in multiple order books and/or sides." Executions carry the Order ID of the resting order and a "Match ID … Assigned by the system to each match executed". An order book is one tradable instrument; in IDX terms, one code on one board.
- **What follows (inferred):** an order number is not exchange-wide, so comparing numbers across codes means nothing. It is not a broker's own sequence either: all brokers' orders in one code and side share one sequence. "Order numbers within a small gap" therefore compares the orders of one code and side, which is exactly the sweep's scope. The spec does not say the IDs are dense, monotonic in time, or reset daily. Those are **live checks 2 and 4**.
- **The brokers keep two numbers.** Stockbit's order-queue message has `order_number` (int64) and a separate `exchange_order_number {full (int64), formatted}` (**[sb]** `20793-…`, `56194-9216e831850ae0f7.js`). Ajaib's own order screens keep `orderno` and `idxno`/`idx_order_id`. Ajaib's Order Queue (`v1/stock/data/order-queue/<code>/<price>`, column `ID ORDER`) parses `order_num` into a string because it may exceed 2^53, and it pages with `from_order_num` in `order_num` order (**[aj]** `zX`, `sZ`). So which number the tape's `buy_order_number` is, a broker re-key or the exchange's, is open. If it is a small per-book count like **[mcp]**'s `27642`, gaps between numbers still mean "orders entered in between, in this code". **Live check 2.**
- **What a gap means** (for a later ticket, inferred): two of one broker's aggressor orders with numbers k and k + 3 had two other orders entered in that code (on that side, if the number is per side) between them. A small gap suggests one algorithm or one trader slicing a parent order. It does not prove it.

## Recommendation

Take order numbers from **Stockbit's running-trade rows** in the existing Stockbit walk. Read `buy_order_number` and `sell_order_number` per trade, plus `group_order_number` if live check 3 confirms it is the aggressor's. No new route, no join, every board, and the trade number on the same row. Keep **Ajaib Done Details** `type=TRADE` as the documented fallback, joined on (code, board, second, price, lots, buyer, seller). Decide only after live checks 1–2. If Stockbit's whole-market rows come back with `"0"` after the close, Done Details becomes the main route.

## Live DevTools checks

Run each in a signed-in tab after 17:00 WIB on a trading day, from the page's own request (Copy as fetch), changing only the query.

1. **Stockbit values after the close.** Call `order-trade/running-trade?sort=ASC&order_by=RUNNING_TRADE_ORDER_BY_TIME&limit=100&date=<today>` with no `symbols`, which is the walk's call. Are `buy_order_number`, `sell_order_number` and `group_order_number` non-zero on every row, `RG`, `NG` and `TN` alike? Repeat with `date=<yesterday>` and a date a month back, so the gap walk and History walk get them too. Record when they turn non-zero next to the time `is_open_market` turns false.
2. **Which number it is, and its scope.** In one stock (for example `BBCA`), take one trade's `buy_order_number`. Then:
   - Compare it with the same order in Stockbit's order queue (`order_number` vs `exchange_order_number.full`/`formatted`).
   - Compare it with the same trade's `buyer.order_id` in Ajaib's Done Details.
   - Over a whole day of one code, sort the distinct buy order numbers. Are they increasing in time, and dense or sparse?
   - Do buy and sell numbers overlap, which means a per-side sequence?
   - Does the same number appear in another code the same day, which means per order book?
   - Compare a day's first numbers with the previous day's, to see whether they reset.
3. **`group_order_number`.** On 200 rows of one code, check whether `group_order_number` equals `buy_order_number` when `action` is `buy` and `sell_order_number` when it is `sell`. Also call `running-trade/group?symbols=<CODE>&date=<today>&limit=50` and record `single_order` and one group's fields.
4. **Order spanning seconds.** Find an order number that appears on trades in two different seconds, or confirm that within a sample of 5,000 trades an order's trades stay in one second. A resting order does span seconds. Check that the aggressor's mostly does not.
5. **Ajaib tape after the close.** Fetch one `running_trades/` page at 17:00. Confirm the row still has no order field.
6. **Done Details paging.** With the owner's URL, try `page_size` 1,000, 5,000 and 10,000. Record the largest the server honours, whether `cursor` and `page` can mix, and `has_next`/`total_pages`. Compare the row count with the server's default time window against `start_time=00:00:00&end_time=23:59:59`, to see whether pre-opening and post-closing trades are outside the default.
7. **Done Details row shape on TRADE.** Record a full row. Note whether it has `code`, `board`/`market_type`, `trade_num`, a side or aggressor field, and both `buyer.order_id` and `seller.order_id` non-empty. Then call `broker-transaction/detail?order_id=<buyer.order_id>&type=TRADE&group=BS&market_date=<day>&code=<CODE>&side=BUY` and record what it lists.
8. **Done Details join.** For one code-day, match Done Details rows to the walk's trades on (board, second, price, lots, buyer, seller). Record how many keys tie, whether every key's counts agree, and whether rows within a second come in trade-number order.
