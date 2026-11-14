# How Stockbit's REST running-trade tape exposes buyer and seller broker codes after the close

Research for [#124](https://github.com/apinrdw/kumora/issues/124), under the map [#123](https://github.com/apinrdw/kumora/issues/123). Read on 2026-11-07. It builds on [`rest-tape-backfill.md`](https://github.com/apinrdw/kumora/blob/research/rest-tape-backfill/docs/research/rest-tape-backfill.md) (#61), [`stockbit-live-data.md`](https://github.com/apinrdw/kumora/blob/research/stockbit-live-data/docs/research/stockbit-live-data.md) (#39), [`idx-trading-schedule.md`](https://github.com/apinrdw/kumora/blob/research/idx-trading-schedule/docs/research/idx-trading-schedule.md) (#56) and the DevTools results on [#48](https://github.com/apinrdw/kumora/issues/48). It does not repeat their parameter tables.

## Answer

The broker codes come from the same route as the live REST tape, `GET https://exodus.stockbit.com/order-trade/running-trade`. Each row carries `buyer` and `seller`, each a string such as an IDX broker code followed by a `[D]` or `[F]` tag, plus `buyer_type` and `seller_type`. The web app shows the Buyer and Seller columns only when the response says `is_open_market: false`, and pages with the `trade_number` cursor only in that same state. The post-close fetch is therefore exactly what Stockbit's own UI does after the close.

A whole day is 13,000–22,000 calls of 100 rows. That takes 3.6–6.1 hours at one call per second, or 22–37 minutes at ten per second. No rate limit is documented. The real limit, and how parallel the fetch can go, is a live check.

Two parts are weaker than the rest:

- **Past days.** The UI sends `date` only when exactly one stock is selected ("Running Trade History Only for Single Stock"), for dates from 2025-01-01 to today. Whether the server accepts `date` on the whole-market tape is unknown. If it does not, a past day is fetched stock by stock, which costs about the same number of calls.
- **When codes appear.** The bundle only reacts to `is_open_market`. The time the server flips it, and the time it fills `buyer`/`seller` for every row, have not been observed.

## Sources

| Tag | Source | Version |
|---|---|---|
| **[sb]** | stockbit.com Next.js bundle, `buildId` `v3.55.0`: 312 page and shared chunks plus 323 lazy chunks from the webpack runtime, fetched anonymously with a browser User-Agent | chunk names below, 2026-11-07 |
| **[mcp]** | [`INo-xious/stockbit-mcp`](https://github.com/INo-xious/stockbit-mcp) `src/core/market.ts`, `docs/LIVENESS.md`, `docs/stockbit-api.md`: a REST client with live probes recorded in its comments | `1a8e482c342af004c20acb72c818307060fbc2ee` |
| **[#48]** | Owner's DevTools capture in signed-in tabs, 2026-11-06 09:36–09:41 WIB | issue comments |
| **[idx]** | IDX Rule II-A, Kep-00158/BEI/10-2026, as summarised in `idx-trading-schedule.md` (#56) | 2026-11-06 |

The bundle shows what the web app sends and renders, not what the server enforces. **[mcp]** is second-hand but records live probes. The bundle moved from `v3.54.12` (#61) to `v3.55.0`. The running-trade chunk `18430-d9c187f91165df68.js` kept the same hash, so its code is unchanged.

## The broker fields

### Row fields

The tape table renders a Buyer column from `buyer` and `buyer_type`, and a Seller column from `seller` and `seller_type` (**[sb]** `18430-d9c187f91165df68.js`, modules `63267` and `42593`). **[mcp]** observed the same fields on a closed market, plus `buy_order_number` and `sell_order_number`. **[#48]** saw `is_broker_exists: false` on the whole-market tape during the session, with `buyer` and `seller` as `""`. The bundle never reads `is_broker_exists`.

The other row fields the tables read: `trade_number` (string), `time` (`HH:MM:SS`), `code`, `price`, `change`, `action` (`buy`/`sell`), `lot`, `value` (`{ raw, formatted }`), `market_board`. The response wraps them as `data.running_trade[]`, with `data.is_open_market` and `data.date` (`YYYY-MM-DD`) beside them (**[sb]** `43309-3dad735fc85e50b7.js`).

### Broker code format

The broker cell (**[sb]** `18430-…`, module `4609`) splits the string with this regex from module `5704` (**[sb]** `41342.7c243313ff23a6b2.js`):

```js
/^(.*?)(\[([DF])\])$/
```

- **Label:** everything before the tag, which is the broker code. The highlight check compares `label.trim()` to the filter's broker code, so the label may end in a space, as in `YP [D]`. The exact spacing is a live check.
- **Tag:** `[D]` or `[F]`, optional. The app maps it to the investor-type filter: `F` is a foreign buyer or seller, `D` a domestic one. With no tag the whole string is the code.
- **`buyer_type` / `seller_type`:** one of `BROKER_TYPE_FOREIGN`, `BROKER_TYPE_GOVERNMENT`, `BROKER_TYPE_LOCAL` or `BROKER_TYPE_UNSPECIFIED`. These describe the brokerage firm and only choose the cell's colour (**[sb]** `41342.…`). They are a different fact from the `[D]`/`[F]` investor tag.

The grouped route `/order-trade/running-trade/group` returns `buyer` and `seller` as arrays of `{ broker_code, broker_type }` instead (**[sb]** `18430-…`, the grouped table). It merges trades by order, so it does not fit a per-trade store.

### When the codes appear

- Both tape tables hide the Buyer and Seller columns while `is_open_market` is true (**[sb]** `18430-…`: `B||e.push({title:"Buyer",…})` in module `63267`, `condition:!D` in module `42593`, where `B` and `D` are `isOpenMarket`).
- While `is_open_market` is true, the hook also clears any buyer, seller or investor-type filter the user set (**[sb]** `18430-…`, module `37893`, `onSuccess`).
- So the server decides. The bundle has no clock of its own for this. The flip time, and whether every row has codes at that moment, are not observed.
- Trades keep printing after the Regular Market closes: the post-closing session runs 16:02–16:15 and the Negotiated Market until 16:30 WIB, Monday to Friday (**[idx]**). A complete day cannot exist before 16:30.
- **[mcp]** reports that broker-derived data across this API (its broker flow chart) publishes at about 18:00 WIB and serves the previous session before that. That claim is about the chart, not the tape, but it is a reason to verify that the codes are complete, not just present.

Treat a day as fetchable only when a page returns `is_open_market: false` and every row has a non-empty `buyer` and `seller`. Retry later otherwise.

## Past days

- The tape takes `date=YYYY-MM-DD` (#61). The app sends it only from the date picker.
- The date picker is disabled unless exactly one stock is selected. Its tooltip reads "Running Trade History Only for Single Stock" (**[sb]** `18430-…`, module `22770`). Choosing All Stock, a watchlist or several stocks resets `date` to null (**[sb]** `9293.912124a97e536801.js`, `setStock`).
- The picker allows dates from 2025-01-01 to the end of today (`filterDate` in module `22770`). That is a UI limit. The server's own limit is unknown.
- **[mcp]** notes that "hotlist/running-trade return empty during closed market". That probe probably sent no `date`. If today's tape empties overnight without a `date`, the extension must always send `date`.

If the server refuses or ignores `date` without `symbols`, a past day has to be fetched one stock at a time: one cursor chain per traded stock. The cost is about trades / 100 plus one call per traded stock (an estimated 900 a day, not measured), so about 14,000–23,000 calls. It also lets the chains run in parallel, one per stock.

## Paging a whole day

### The call

```
GET /order-trade/running-trade
  ?sort=ASC
  &order_by=RUNNING_TRADE_ORDER_BY_TIME
  &limit=100
  &date=<YYYY-MM-DD>
  [&trade_number=<last row's trade_number>]
```

- No `symbols`, so the whole market. No `market_board`, so every board (see below).
- The first call has no `trade_number`. **[mcp]** measured that `order_by=1` (`TIME`) without a cursor starts at the session open.
- Each next call sends the last row's `trade_number`. The app's own "load more" does exactly this, without `cursor_direction`, so `CURSOR_DIRECTION_NEXT` is the default and means "further along in the sort order" (**[sb]** `18430-…`, module `37893`, `getNextPageParam`). The app sends `CURSOR_DIRECTION_PREVIOUS` with the first row's number to go the other way.
- Stop on an empty page. Then check that every trade number from 1 to the largest seen is present.
- `sort=DESC` from the newest trade works the same way. The app's default is `DESC` with `limit: 80`.

### Caps

- **`limit` caps at 100.** **[mcp]** measured `101` and `250` → 100 rows, and `200` and `3000` byte-identical. The cap is silent.
- `offset` and `page` do nothing (**[mcp]**). The cursor is the only way through the day.
- The trade number is one market-wide daily sequence (**[#48]**). So the number of calls is the day's trade count / 100.

### Rate limit and Cloudflare

- No documented limit. The bundle has no throttle on this route and no 429 handling for it (**[sb]** `18755-3f6fca7ae3648b6f.js`, the axios client).
- Cloudflare and CloudFront front the API (**[mcp]** `stockbit-api.md`). The axios client treats a `403` with `cf-mitigated: challenge` as a Turnstile challenge and opens a solver (**[sb]** `18755-…`). A content script making the calls has no solver UI, so the call fails. The page itself could solve it if the user is in the tab.
- **[mcp]** advises keeping the rate "human-ish" because the calls run on the user's own KYC'd brokerage account.

### Call count and wall time

| Day | Calls (100 rows each) | At 1 call/s | At 4 calls/s | At 10 calls/s |
|---|---|---|---|---|
| 1.3M trades | 13,000 | 3.6 h | 54 min | 22 min |
| 2.2M trades | 22,000 | 6.1 h | 92 min | 37 min |

- One cursor chain is sequential, so its speed is one call per round trip. A round trip of 250 ms gives about 4 calls/s. That round trip is an assumption. Measure it.
- To go faster, run several chains at once. The trade number is a dense daily sequence, so the day splits into ranges, each started at its own `trade_number` and stopped at the next range's start. This needs the server to accept a `trade_number` the app never returned (live check). Per-stock chains are the other way to split.
- **Data volume:** an estimated 300–500 bytes of JSON per row, so about 0.4–1.1 GB per day before compression. This is an estimate from the field list, not a measurement.

## Board coverage

- The default whole-market call sends no `market_board`, which the filter builder maps to "all" (**[sb]** `41342.…`, module `5704`: `BOARD_TYPE_ALL`, `_REGULAR`, `_CASH`, `_NEGOTIATION`).
- Rows carry `market_board` as `RG`, `TN` or `NG`. The table colours all three (**[sb]** `18430-…`, module `16223`). So the tape is built to hold every board.
- **[#48]** saw only `RG` in a five-minute morning window. That says nothing about `TN` or `NG`, which are rare.
- Whether negotiated (`NG`) trades take a number in the same sequence, and whether their broker codes are filled, is a live check. If they do not share the sequence, the "no missing numbers" completeness check needs a per-board variant.

## Needs a live DevTools check

Run each in a signed-in stockbit.com tab, after 16:30 WIB on a trading day unless stated.

1. **Flip time.** From 15:45 to 18:30 WIB, call the whole-market tape once a minute. Record when `is_open_market` turns false, when `buyer`/`seller` become non-empty, and when every row on the first and last pages has them.
2. **Format.** Record real `buyer`/`seller` strings (spacing before `[D]`/`[F]`, any untagged codes), `buyer_type`/`seller_type`, and `is_broker_exists`.
3. **Whole-market `date`.** Call with `date=<yesterday>` and no `symbols`. Does it return yesterday's whole tape, today's, or an error? Repeat for a date a week, a month and a year back, and for 2024-12-31.
4. **Same day, overnight.** After midnight, call with and without `date=<previous trading day>`. Does the tape still serve it?
5. **Cursor semantics.** With `sort=ASC`, is the row at `trade_number=N` excluded (next page starts at N + 1)? Does an arbitrary `trade_number` (one never returned) work as a start point?
6. **Completeness.** Page a whole stock, or a 10,000-number stretch, and check for no missing trade numbers. Check that `NG` and `TN` rows appear and where their numbers sit.
7. **Rate limit.** 100 calls at 1/s, then at 4/s, then 10 back to back. Watch for 429, a `403` with `cf-mitigated`, empty pages, or a slowdown. Record the round-trip time.
8. **Parallel chains.** Two to four chains at once from one tab, under the limit found in check 7.
9. **Response size.** Bytes per 100-row page, compressed and not.
