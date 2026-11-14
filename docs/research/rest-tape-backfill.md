# Whether Stockbit's and Ajaib's REST running-trade tapes can fetch a trade-number range

Research for [#61](https://github.com/apinrdw/kumora/issues/61), under the Market Live map [#38](https://github.com/apinrdw/kumora/issues/38). Read on 2026-11-06. It builds on [`stockbit-live-data.md`](https://github.com/apinrdw/kumora/blob/research/stockbit-live-data/docs/research/stockbit-live-data.md) (#39), [`ajaib-live-data.md`](https://github.com/apinrdw/kumora/blob/research/ajaib-live-data/docs/research/ajaib-live-data.md) (#40) and the DevTools results on [#48](https://github.com/apinrdw/kumora/issues/48), and does not repeat them.

## Answer

**Stockbit can, by cursor.** Its REST tape takes a `trade_number` cursor and a `cursor_direction`. The web app pages its own running-trade table this way: the next page starts after the last row's `trade_number`, the previous page before the first row's. So a gap X–Y can be read as "up to 100 rows next to trade number Y + 1 (or X − 1)". There is no `from`/`to` range parameter: the call returns one page of up to 100 whole-market rows, and the content script keeps the rows inside X–Y.

**Ajaib cannot.** Its REST tape has no trade-number parameter. It pages by a fixed `last_timestamp` (epoch ms) plus `page`, newest first. It can fill a gap only through a time window, and only after its 2-minute lag has passed.

**Recommended backfill call:** Stockbit, `sort=DESC`, `order_by=RUNNING_TRADE_ORDER_BY_TIME`, `limit=100`, `trade_number=<Y + 1>`. Repeat with the last row's `trade_number` while the gap is not covered. Ajaib by time window is the fallback, at least 2 minutes after the gap. Several cursor semantics need a live DevTools check before the spec relies on them (see the last section).

## Sources

| Tag | Source | Version |
|---|---|---|
| **[sb]** | stockbit.com Next.js bundle, `buildId` `v3.54.12`, 323 chunks fetched anonymously with a browser User-Agent | chunk names below, 2026-11-06 |
| **[aj]** | trade.ajaib.co.id Vite bundle, entry `index-DKOtYJk3.js`, 142 chunks crawled from the entry | chunk names below, 2026-11-06 |
| **[mcp]** | [`INo-xious/stockbit-mcp`](https://github.com/INo-xious/stockbit-mcp) `src/core/market.ts` and `docs/LIVENESS.md`, a REST client with live probes recorded in its comments | `1a8e482c342af004c20acb72c818307060fbc2ee` |
| **[#48]** | Owner's DevTools capture in signed-in tabs, 2026-11-06 09:36–09:41 WIB | issue comments |

The bundles are the primary source for parameter names. They show what the web app sends, not what the server accepts or caps. **[mcp]** is second-hand but records live probes.

## Stockbit: `GET https://exodus.stockbit.com/order-trade/running-trade`

### Parameters

The API wrapper passes its params straight through and serializes arrays as repeated keys (`symbols=A&symbols=B`). **[sb]** `46906-555ef29a8cd8b23a.js`, module `61262`, `getInitRunningTradeV3`.

The running-trade hook builds the query from three parts. **[sb]** `18430-d9c187f91165df68.js`, module `37893`:

1. **Initial params:** `{ sort: "DESC", limit: 80, order_by: "RUNNING_TRADE_ORDER_BY_TIME", trade_number: undefined }`. The sort values are `ASC` and `DESC`. The `order_by` values are `RUNNING_TRADE_ORDER_BY_TIME`, `RUNNING_TRADE_ORDER_BY_LOT` and `RUNNING_TRADE_ORDER_BY_VALUE` (same chunk, module before `37893`). The company-page widget uses `limit: 10`, the main widget and fast order `limit: 80` (same chunk, the `IE` export).
2. **Filters**, built by `dC` in module `5704` (**[sb]** `screener-8592b13305301255.js`):

| Param | Value |
|---|---|
| `symbols` | stock codes, repeated. Omitted for "All Stock" (`*`). Singular `symbol` is silently ignored (**[mcp]**) |
| `action_type` | `RUNNING_TRADE_ACTION_TYPE_ALL`, `_BUY`, `_SELL` |
| `market_board` | `BOARD_TYPE_ALL`, `_REGULAR`, `_CASH`, `_NEGOTIATION` |
| `investor_type` | `RUNNING_TRADE_INVESTOR_TYPE_ALL`, `_FOREIGN_BUY`, `_FOREIGN_SELL`, `_DOMESTIC_BUY`, `_DOMESTIC_SELL`, repeated |
| `price_range_from`, `price_range_to` | numbers |
| `minimum_lot` | number |
| `value_from`, `value_to` | numbers |
| `time_range.start`, `time_range.end` | `HH:mm` strings (the filter's default `timeFormat`) |
| `broker_buy`, `broker_sell`, `broker_operator` | broker codes; `FILTER_BROKER_OPERATOR_AND` or `_OR` |
| `watchlist_id` | number, for "Watchlist" mode |
| `date` | `YYYY-MM-DD`, sent only when the user picks a date |

3. **Page cursor**, from react-query's `getNextPageParam` / `getPreviousPageParam` in module `37893`:
   - Next page: `{ trade_number: <last row's trade_number> }`.
   - Previous page: `{ trade_number: <first row's trade_number>, cursor_direction: "CURSOR_DIRECTION_PREVIOUS" }`.
   - The enum also has `CURSOR_DIRECTION_NEXT` (**[sb]** `9293.5f722a92ed0608ae.js`, module `88633`). The app never sends it, so NEXT is presumably the default.
   - Both set `order_number` and `group_action` to `undefined`. Those two are the cursor of the grouped route `/order-trade/running-trade/group`.

Other observations:

- **Max `limit`: 100.** **[mcp]** measured `limit=100` → 100 rows, `101` → 100, `250` → 100, and 200 and 3000 byte-identical. Silent truncation, no error.
- **`order_by` is required.** Without it the server answers `400 OrderBy is a required field`. The numeric forms `1`, `2`, `3` are accepted, `0` and `4` refused (**[mcp]**). The app sends the enum names.
- **`offset` and `page` do nothing** (**[mcp]**). The trade-number cursor is the only way to move the window.
- **Response:** `data.running_trade[]` (rows with `trade_number` as a string, `time` as `HH:MM:SS`, `code`, `price`, `lot`, `action`, `market_board`, `buyer`, `seller`, …), plus `data.is_open_market` and `data.date` (**[sb]** `43309-3dad735fc85e50b7.js`; row fields from **[#48]** and **[mcp]**).

### How the app uses it during market hours

While `is_open_market` is true, the widget shows the websocket tape seeded by the first REST page, and it does not page. Paging with the cursor ("load more") runs only when the market is closed (**[sb]** `43309-…`, the `U ? socket view : paged list` branch). The filter UI also hides **Time Range** and **Investor Type** while the market is open (**[sb]** `18430-…`, `!t&&` around "Time Range"). So the bundle does not prove that the server honours `trade_number` or `time_range.*` during the session. The server may simply accept them. **Live check 1 and 2.**

### Lag

- **[#48]** with `sort=DESC`: the newest row matched page-load time. Current, not behind.
- **[mcp]** `docs/LIVENESS.md` reports **8–10 minutes behind**. That client sent `order_by=1` and no `sort`, so its window started at the session open (ascending, 100 rows). Its lag figure is most likely an artefact of reading the oldest rows, not the newest. **[#48]** wins.

### Auth and headers

`Accept: application/json` and `Authorization: Bearer <credentialStorage.access.token>`, attached by the axios request interceptor (**[sb]** `15449-…`, module `18755`). The content script in the Stockbit tab can call it as the page does. It must never refresh the token (see #39).

### Rate limits

- No documented limit, and no client-side throttle in the bundle. The only 429 handling in **[sb]** is the social "daily follow limit" modal.
- The axios client does handle a **Cloudflare challenge**: a `403` with `cf-mitigated: challenge` triggers a Turnstile flow (**[sb]** `15449-…`, module `18755`). A burst of backfill calls may trip it. In a content script there is no UI to solve it, so the call just fails.
- **Live check 4.** Until it is measured, coalesce gaps and send at most about one call per second.

## Ajaib: `GET https://ht2.ajaib.co.id/api/v1/stock/detail/running_trades/`

### Parameters

The query builder `JC` (**[aj]** `index-DKOtYJk3.js`, near `qC="/v1/stock/detail/running_trades/"`) sends exactly:

| Param | Value |
|---|---|
| `last_timestamp` | epoch ms; defaults to `Date.now()` |
| `direction` | always `DESC` in the app |
| `side` | `BUY` or `SELL`; omitted for all |
| `min_lot`, `min_price`, `max_price` | numbers |
| `page` | 1-based |
| `page_size` | the app uses 40 for the whole market, 8 or 40 for one code (`fj`/`pj`, `mj = 40`) |

- **No trade-number parameter and no symbol filter** on the whole-market route. A single code has its own route, `v1/stock/detail/{CODE}/running_trades/`, with the same query.
- **Paging:** the app fixes `last_timestamp` once (when the user scrolls past the live rows) and increments `page` while `has_next` (or `next`) is truthy (**[aj]** `running-trade-pagination-BbXY459p.js`: `e => !!(e?.has_next ?? e?.next)`, and `ZC`).
- **Max `page_size`:** unknown. **Live check 5.**
- **`direction=ASC`:** never sent by the app. Unknown. **Live check 5.**
- **Response:** `results[]` with `trade_num` (`YYYYMMDD` + 10 digits), `timestamp` (ms), `time`, `date`, `stock_code`, `price`, `lot`, `side`, …, plus `has_next`, `page`, `total_pages` (**[#48]**).

### Lag

**2 minutes behind** (**[#48]**: with `last_timestamp` at page-open time 09:36:10, the newest row was 09:34:10). A trade becomes readable over REST only about 2 minutes after it happened. Whether a past `last_timestamp` returns rows at or before that time (the obvious reading) is **live check 6**.

### Auth and headers

The page's own headers: `Authorization: jwt <trade_access_token>`, `X-Platform: WEB`, `X-Product: stock-mf`, `x-app-mode: PRO`, `X-Device-Name`, `X-Device-Signature`, `X-Ht-Ver-Id`, `x-web-version`, `Accept-Language: id` (#40). **[#48]** found that `Authorization` alone gets 403 and the page's full header set gets 200. GETs are not signed. The access token lives 15 minutes and the page refreshes it, so the extension should read the current cookie at call time, or reuse headers from the page's own latest request.

### Rate limits

None in the bundle. The app's own query sets `staleTime: 2000`. **Live check 4.**

## Filling a known range

The Durable Object knows the gap X–Y and the times of its neighbours, trade X − 1 and trade Y + 1 (Stockbit times are sub-second).

**Stockbit, by number (recommended):**

1. `GET /order-trade/running-trade?sort=DESC&order_by=RUNNING_TRADE_ORDER_BY_TIME&limit=100&trade_number=<Y + 1>`. No `symbols`, so the whole market.
2. Keep rows with `X ≤ trade_number ≤ Y`. If the smallest returned number is still above X, call again with `trade_number=<smallest returned>`.
3. One call covers a gap of up to about 100 numbers. The measured socket gaps were 46 and 143 numbers (**[#48]**), so one or two calls.
4. Add `date=<YYYY-MM-DD>` only if the call must name the trading day (for example a late fill near midnight). The app omits it for today.

Equivalent ascending form: `sort=ASC&trade_number=<X − 1>`. Which form is exclusive or inclusive of the cursor, and whether NEXT means "further along in the sort order", is **live check 1**. Both forms are safe if the script filters by X–Y and keeps paging until X and Y are both passed.

**Stockbit, by time (if the cursor is ignored while the market is open):** `time_range.start` and `time_range.end` in `HH:mm` select whole minutes. A gap inside one minute at 263 trades/s peak means up to about 16,000 rows in that minute, far more than 100 rows. The window is useful only together with the cursor or with `sort=ASC`, so it is a poor fallback. **Live check 2.**

**Ajaib, by time (fallback):**

1. Wait until `now ≥ time(Y + 1) + 2 min + margin`.
2. `GET running_trades/?last_timestamp=<time(Y + 1) + 1000>&direction=DESC&page=1&page_size=<max>`. Add 1 s because Ajaib rounds times to the second.
3. Increment `page` while `has_next` and while the smallest `trade_num` seen is still above X. Keep rows whose last 10 digits fall in X–Y.
4. Cost: the whole market runs about 65 trades/s on average and 263 at peak, so each second of gap is 2–7 pages of 40. A 1–2 s gap is a handful of calls.

Because of the 2-minute lag, Ajaib cannot fill a gap within seconds. It fills gaps that Stockbit's call missed, about 2 minutes later.

## Live DevTools checks

Run each from the signed-in tab during market hours. Each check is still open; nothing above has been confirmed against the live server except where **[#48]** is cited.

1. **Stockbit cursor during the session.** Call with `sort=DESC&limit=100&order_by=RUNNING_TRADE_ORDER_BY_TIME&trade_number=<N>` for an N from a few minutes ago. Check that rows start just below N (or at N), stay in descending order, and come from the whole market. Repeat with `cursor_direction=CURSOR_DIRECTION_PREVIOUS`, and with `sort=ASC&trade_number=<N>`. Record which is inclusive and which direction each returns.
2. **Stockbit `time_range.*` during the session.** Does `time_range.start=09:40&time_range.end=09:41` restrict the rows? Is `HH:mm:ss` accepted?
3. **Stockbit row completeness.** Over a run of 100 consecutive numbers from one call, check that no number is missing (that is, the REST tape is not sampled or filtered by board).
4. **Rate limits on both sites.** Send 10 calls at 1/s, then 10 back to back. Watch for 429, a Cloudflare 403 with `cf-mitigated`, or empty pages.
5. **Ajaib `page_size` cap and `direction=ASC`.** Try `page_size=100`, `500`, `1000`.
6. **Ajaib past `last_timestamp`.** Set it to 10 minutes ago and check that the newest row is at or just before it, not 2 minutes before now.

## Recommendation

- **Backfill call:** Stockbit `GET /order-trade/running-trade?sort=DESC&order_by=RUNNING_TRADE_ORDER_BY_TIME&limit=100&trade_number=<Y + 1>`, paged by the smallest returned `trade_number` until X is passed, filtered to X–Y. Bearer token from the tab.
- **Fallback:** Ajaib `running_trades/` by `last_timestamp = time(Y + 1) + 1 s`, paged by `page`, sent no sooner than 2 minutes after the gap, with the page's own headers. Filter by the last 10 digits of `trade_num`.
- **Throttle:** coalesce adjacent gaps into one request and keep at most about one call per second per site until check 4 is done.
- **If check 1 fails** (cursor ignored while the market is open), Stockbit cannot fill a gap older than its newest 100 rows. At 65–263 trades/s that is under 2 seconds, so the 5 s wait would always miss. Then Ajaib by time becomes the only backfill, 2 minutes late.
