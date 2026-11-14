# How Ajaib's REST running-trade tape exposes buyer and seller broker codes after the close, and how fast a whole day pages out

Research for [#125](https://github.com/apinrdw/kumora/issues/125), under the map [#123](https://github.com/apinrdw/kumora/issues/123). Read on 2026-11-07. It builds on [`ajaib-live-data.md`](https://github.com/apinrdw/kumora/blob/research/ajaib-live-data/docs/research/ajaib-live-data.md) (#40), [`rest-tape-backfill.md`](https://github.com/apinrdw/kumora/blob/research/rest-tape-backfill/docs/research/rest-tape-backfill.md) (#61) and the DevTools results on [#48](https://github.com/apinrdw/kumora/issues/48). It does not repeat their auth, header and lag findings.

## Answer

**The same whole-market route carries them.** `GET https://ht2.ajaib.co.id/api/v1/stock/detail/running_trades/` returns `buyer` and `seller` (broker codes), `buyer_type`, `seller_type`, `buyer_color` and `seller_color` on every row. Ajaib's own Running Trade table shows the **Buyer** and **Seller** columns, and lets the user scroll the tape back page by page, only when its market status is **not OPEN**. That is the web app's post-close mode. During the session both features are switched off, and #48 saw the fields empty.

**A whole day is 13,000–55,000 calls**, depending on the `page_size` cap the server accepts. At the app's 40 rows per page that is 32,500–55,000 calls: 9–15 hours at 1 call/s, about 2–3 hours at 5 calls/s. Both the cap and the rate limit are unknown until a live check, and they decide whether one evening is enough.

**Past days:** `running_trades/` has no date parameter. Whether a `last_timestamp` from an earlier day reaches that day is unknown. A second route, **Done Details** (`v1/stock/data/broker-transaction`), takes an explicit `market_date` and has no lower date bound in the app. But it works per stock code, and its rows show no trade number.

## Sources

| Tag | Source | Version |
|---|---|---|
| **[aj]** | trade.ajaib.co.id Vite bundle, entry `index-DKOtYJk3.js`, 142 chunks crawled from the entry, plus `/__ENV.js` (`VITE_PUBLIC_API_URL = https://ht2.ajaib.co.id/api/`) | fetched anonymously 2026-11-07. It is the same entry hash #61 read on 2026-11-06 |
| **[#48]** | Owner's DevTools capture in a signed-in tab, 2026-11-06 09:36–09:41 WIB, during the session | issue comments |
| **[probe]** | Anonymous `curl` to `ht2.ajaib.co.id` from this machine, 2026-11-07 | response headers only |

The bundle shows what the web app sends and renders. It does not show what the server caps, rate-limits or fills in. Minified names (`JC`, `KC`, `fw`, …) change with every release. Search a newer bundle for the quoted string literals instead.

## The route and its fields

`GET v1/stock/detail/running_trades/?last_timestamp=<ms>&direction=DESC&page=<n>&page_size=<n>[&side=&min_lot=&min_price=&max_price=]`. The query builder is **[aj]** `index-DKOtYJk3.js`, `qC="/v1/stock/detail/running_trades/"` and `JC`. The parameters are unchanged from #61: no trade-number, symbol, board or date parameter.

The row component `GC` (`displayName "TradeRow"`) renders these row fields when the buyer/seller columns are on (**[aj]**):

| Field | Meaning |
|---|---|
| `buyer`, `seller` | Broker code. An empty value renders as `-` |
| `buyer_type`, `seller_type` | Broker category. The chip `BC` puts it in `data-broker-type`, and the CSS styles the values `LOCAL-BROKER`, `FOREIGN-BROKER`, `BUMN` and `OTHER` |
| `buyer_color`, `seller_color` | Legacy colour hex. The CSS matches `#DF1401`, `#2978AE` and `#FABC2A` in `data-broker-old-color` |
| `trade_num` | `YYYYMMDD` + 10 digits (**[#48]**). The table keys rows by `trade_num`, or by `timestamp` when that is missing |
| `stock_code`, `price`, `lot`, `side`, `date`, `time`, `timestamp`, `return_pct`, `market_type` | As in #40. `market_type` is never rendered |

**Broker code format:** the bundle renders the code as an opaque string. These are IDX exchange-member codes, two uppercase letters such as `YP` or `CC` (**inferred**: the bundle does not check the format). Store it as a string and don't validate its length. The live check confirms the format.

The response wrapper is `{ results[], has_next | next, page, total_pages }` (**[#48]**). The app pages while `!!(has_next ?? next)` (**[aj]** `running-trade-pagination-BbXY459p.js`).

## When the codes appear

- The table computes `showBuyerSeller = alwaysShowBuyerSeller || !isMarketOpen` (**[aj]** `KC`: `A=!i, j=v||A`). It adds the `buyer` and `seller` columns only when `j` is true.
- `isMarketOpen` comes from hook `fw`. It reads the current phase's `status` from the market schedule and compares it with `OPEN`. Without a schedule, it falls back to `GET v1/stock/data/trading-day/time/` `result.status === "OPEN"`. Hook `dw` refetches that endpoint at each `phase_1_open`, `phase_1_close`, `phase_2_open` and `phase_2_close`.
- Infinite scroll ("load more") also runs only when the market is not open: the sentinel calls `onLoadMore` only if `A` (`!isMarketOpen`) is true.
- So the web app's design is a live tape with no brokers during the session, and a full, scrollable tape with brokers once trading stops. This matches what the owner saw after the close. It also matches #48, which saw empty fields at 09:36.
- **Not known from the bundle:** when the server fills the fields. The UI switch is client-side. Two cases are open: whether the codes appear right at the close or minutes later (end-of-day processing), and whether they appear during the lunch break, when the client already shows the columns. **Live check 1.**
- **A hint from Done Details:** that feature refuses to query today's date while `trading-day/time/` `status !== "CLOSED"` (`isStillMarketTime`). So Ajaib treats the `CLOSED` status as the point where broker-level data for today is ready. The extension can use the same signal as its trigger.

## Paging a whole day

How the app pages after the close (**[aj]** `rw`, `XC`): the first page is `page=1&page_size=40&last_timestamp=Date.now()`. On the first "load more" the app freezes `last_timestamp = Date.now()` and fetches `page=2, 3, …` (`initialPageParam: 2`) with that fixed timestamp. It dedupes on `trade_num`. This is **offset paging** on a fixed snapshot. After the close the snapshot no longer changes, so pages are stable and independent, and they can be fetched in parallel.

| `page_size` | Calls for 1.3M | Calls for 2.2M | At 1 call/s | At 5 calls/s |
|---|---|---|---|---|
| 40 (app) | 32,500 | 55,000 | 9.0–15.3 h | 1.8–3.1 h |
| 100 | 13,000 | 22,000 | 3.6–6.1 h | 43–73 min |
| 1,000 | 1,300 | 2,200 | 22–37 min | 4–7 min |

- **Cap:** unknown. The app sends 8 or 40 and never more. **Live check 2.**
- **Deep offsets:** page 30,000 of a 40-row page means an offset of 1.2M rows. Offset paging can get slow, or the server can cap `page` (`total_pages` may stop short of the whole day). **Live check 3.**
- **Fallback that avoids deep offsets:** walk back by time. Set `last_timestamp` to the oldest row's `timestamp` + 1000 ms, take pages 1, 2, … only while rows still fall in that second, then move the anchor back again. Dedupe on `trade_num`. Timestamps are whole seconds, and the whole market runs up to 134–263 trades/s. So one anchor can need a few pages, and the + 1000 ms overlap guards against an exclusive `last_timestamp`. This needs no cap above 40, but each anchor depends on the previous call, so the calls run one at a time.
- **Rate limit:** the bundle has no handling for 429 or `Retry-After` in its API client. It sets `staleTime: 2000` on the first page. The API host sits behind Cloudflare: an anonymous GET gets a Cloudflare HTML `403` and a `__cf_bm` bot-management cookie (**[probe]**). A burst of tens of thousands of calls may trip bot management, not a documented limit. **Live check 4.**
- **Completeness:** a day counts only when `total_pages × page_size` (or the row count) matches the day's trade count, and when the trade numbers have no gaps. **Live check 5.**

## Past days

- `running_trades/` takes no date. A `last_timestamp` from an earlier day might return that day's tail, or the server might serve only today. **Live check 6.**
- **Done Details:** `GET v1/stock/data/broker-transaction` (**[aj]** `lY`, `uY`, `pY`). Its params:
  - `code` (required)
  - `market_date` (`YYYY-MM-DD`; when omitted, the server picks the latest date and echoes it as `result.market_date`)
  - `group` (`BS`, `BUY` or `SELL`)
  - `type` (`TRADE` or `ORDER`)
  - `broker_code`, `price`
  - `start_time`, `end_time` (`HH:mm:ss`, default `09:00:00`–`16:00:00`)
  - `market_type` (`RG`, `NG` or `TN`)
  - `cursor`

  It pages by `result.next_cursor` while `result.has_next`. Rows are `result.transactions[]` with `time`, `price`, `qty`, and `buyer` and `seller` objects that carry `broker_code`, `type` and, on the ORDER type, `order_id`. The date picker blocks only dates after today (`disabled: {after: new Date}`), so the app sets no lower bound. A holiday returns `err_code: "EC0009003"`.
- Done Details is per stock code, so a day is about one cursor walk per traded code (`v1/stock/data/list/` lists 3,406 instruments, #48). Its rows render no trade number, so they cannot be joined to **Trade number** without matching time, price and quantity, which can be ambiguous. It is a fallback for missed days and a cross-check, not the main path. Its page size, depth and row fields are **live check 7**.
- `v1/stock/data/trading-day/non-holiday` lists trading days, to enumerate the past days to retry.

## Board coverage and trade number

- `running_trades/` has no board parameter. Rows carry `market_type`, which the WebSocket mapping leaves empty and the table never renders. Whether the REST tape includes negotiated (`NG`) and cash (`TN`) trades, and what `market_type` holds, is unknown. **Live check 5.** Done Details does split by `market_type` `RG`, `NG` and `TN`, so Ajaib has broker data for every **Board**.
- `trade_num` is on every REST row (`YYYYMMDD` + 10 digits, **[#48]**). Its last 10 digits are the day's **Trade number**, which lets the extension join Ajaib rows to Stockbit's and check for gaps (**inferred**: #61 matched them by this rule).

## Live DevTools checks

Run these in a signed-in `trade.ajaib.co.id` tab after the close, from the page's own request (Copy as fetch), changing only the query.

1. **When the fields fill.** Fetch `running_trades/?direction=DESC&page=1&page_size=40&last_timestamp=<now>` at 16:00 (just after the close), 16:15, 16:30 and 17:00, and once during the 12:00–13:30 break. Note when `buyer` and `seller` stop being `""`, and what `trading-day/time/` `status` reads at each time.
2. **`page_size` cap.** Try 100, 500, 1,000 and 5,000. Record the largest size the server honours, and whether it clamps or errors.
3. **Deep pages.** With a fixed `last_timestamp`, fetch `page=total_pages`, and a page near the middle. Record the latency and whether `total_pages × page_size` covers the day.
4. **Rate limit.** Send 20 calls back to back, then 5 per second for a minute. Watch for 429, a Cloudflare 403 or challenge, or empty pages.
5. **Completeness and boards.** Over a few thousand consecutive rows, check that the last 10 digits of `trade_num` have no gaps. Record the `market_type` values, and whether `NG` and `TN` trades appear. Record the broker code format and the `buyer_type` values.
6. **Past days.** Set `last_timestamp` to yesterday 15:59:59 WIB. Does the newest row come from yesterday, with brokers? Try 7 and 30 days back.
7. **Done Details.** Fetch `broker-transaction?code=BBCA&group=BS&type=TRADE&market_date=<yesterday>`. Record the rows per page, whether a row carries a trade number or `market_type`, and how far back `market_date` works.
8. **Token expiry during a long fetch.** Check whether replaying the page's request headers still works after the 15-minute `trade_access_token` rotation, or whether every call must read fresh headers.
