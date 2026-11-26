# How Stockbit delivers running trades, intraday candles and stock codes to its web app

Research for [#39](https://github.com/apinrdw/kumora/issues/39), under the Market Live map [#38](https://github.com/apinrdw/kumora/issues/38). Read on 2026-11-06.

## Verdict

Stockbit's web app gets live data from one binary protobuf websocket, `wss://wss-jkt.trading.stockbit.com/ws`. Its schema ships in the public JS bundle. A single subscribe with the symbol `*` on the `running_trade_batch` channel carries the whole-market tape. One-minute candle history comes from a JSON REST route, `GET exodus.stockbit.com/chartbit/{SYMBOL}/price/intraday`. Live candle updates come from the socket's `intraday` channel. The websocket's running-trade record has no broker codes. It does carry a per-stock `trade_number`.

The web app stores the socket on `window.datafeedSocket`, so a MAIN-world content script in an open, signed-in stockbit.com tab can read every frame passively. That is the recommended path. If the extension opens its own connection instead, it must reuse the tab's access token and must never call the refresh route.

Nothing here was observed on a live signed-in session. Every live-behaviour claim is either read from Stockbit's shipped code or reported by a third-party project, and is marked that way.

## Sources

| Tag            | Source                                                                                                                                                                                                                                                                                          | Pinned at                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **[bundle]**   | stockbit.com Next.js bundle, `buildId` `v3.54.12`, fetched anonymously from `https://stockbit.com/_next/static/...`                                                                                                                                                                             | chunk filenames below, 2026-11-06          |
| **[chartbit]** | Chartbit module-federation remote, `https://storage.stockbit.com/chartbit/3.2.0/static/`                                                                                                                                                                                                        | chunk filenames below, 2026-11-06          |
| **[haka]**     | [`nofendian17/stockbit-haka-haki`](https://github.com/nofendian17/stockbit-haka-haki), a Go whole-market tape consumer                                                                                                                                                                          | `18fe1e9ccd6b5437ad4e84a23decc08c75e4bad8` |
| **[ofs]**      | [`silenccy/orderflow-station`](https://github.com/silenccy/orderflow-station), a Python per-symbol websocket consumer                                                                                                                                                                           | `39f4410ea0702bb5209f7a765e6b8e1f5e490173` |
| **[mcp]**      | [`INo-xious/stockbit-mcp`](https://github.com/INo-xious/stockbit-mcp), a REST client with live probes recorded in its docs                                                                                                                                                                      | `1a8e482c342af004c20acb72c818307060fbc2ee` |
| **[ext]**      | [`iqbaladinur/stockbit-extension`](https://github.com/iqbaladinur/stockbit-extension), an MV3 extension that scrapes the DOM                                                                                                                                                                    | `8a554382e1e9f95d52fda37f4ef2db3760579375` |
| **[chrome]**   | Chrome extension docs: [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest), [content scripts](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), [debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger) | read 2026-11-06                            |

The bundle is the primary source. The repos are second-hand: each one shows that a technique worked at its commit, but its prose is not authoritative. `haka`'s `docs/datasource/PROTOBUF_WEBSOCKET_DOCUMENTATION.md` describes the Android app, and parts of it disagree with the web schema, so this note uses that repo's `proto/datafeed.proto` and Go code instead.

## 1. The trading websocket

### Connection

- URL: `wss://wss-jkt.trading.stockbit.com/ws`, with WebSocket subprotocol `"web"`. `?type=chart` is appended for a chart socket. **[bundle]** `47940-771c2b8d36db5402.js`, module `37952`: `new WebSocket(a + (e ? "?type=chart" : ""), ["web"])`.
- `binaryType = "arraybuffer"`. The app assigns the socket to `window.datafeedSocket` and clears it on teardown. **[bundle]** `9293.5f722a92ed0608ae.js`, module `5386`.
- `haka` uses the older host `wss://wss-trading.stockbit.com/ws` (**[haka]** `config/config.go`). The current web bundle references only `wss-jkt.trading`.
- Other sockets in the bundle are unrelated to market data: `wss://ws-gen.stockbit.com/v1` (app heartbeat) and `wss://wssocial.stockbit.com?wskey=` (social). **[bundle]**

### Encoding

Binary protobuf. The app uses protobuf-es and ships the message descriptors in **[bundle]** `20793-dcf9c3587c81dd92.js`, package `securities.transactional.datafeed.v1`. Client to server is `WebsocketRequest`. Server to client is `WebsocketWrapMessageChannel`, a `oneof message_channel`.

`WebsocketRequest`:

| #   | Field          | Type                                 |
| --- | -------------- | ------------------------------------ |
| 1   | `user_id`      | string                               |
| 2   | `channel`      | `WebsocketChannel`                   |
| 3   | `key`          | string (the websocket key, see Auth) |
| 4   | `ping`         | `PingRequest { string message = 1 }` |
| 5   | `access_token` | string (the session JWT)             |

`WebsocketChannel` (all `repeated string` of stock codes unless noted): 1 `watchlist`, 2 `order_book`, 3 `running_trade`, 4 `is_hotlist` (bool), 5 `running_trade_batch`, 6 `liveprice`, 7 `iepiev`, 8 `intraday`, 9 `best_bid_offer`, 10 `market_mover` (message), 11 `order_queue` (message), 12 `liveprice_v3`, 13 `order_book_v3`, 14 `intraday_v3`, 15 `tradebook` (message), 16 `fitem` (message).

`WebsocketWrapMessageChannel` cases: 1 `running_trade`, 2 `ping`, 3 `top20`, 4 `watchlist`, 5 `orderbook_header`, 6 `orderbook_body`, 7 `error`, 8 `running_trade_batch`, 9 `liveprice`, 10 `orderbook`, 11 `iepiev`, 12 `intraday`, 13 `best_bid_offer`, 14 `market_mover_batch`, 15 `order_queue`, 16 `liveprice_v3`, 17 `orderbook_v3`, 18 `intraday_v3`, 19 `tradebook`, 20 `fitem`.

`Error { ErrorCode code = 1; string message = 2 }`, where `ErrorCode` is `0` unspecified, `400` bad request, or `401` unauthorized. **[bundle]**

### Running trade record

`RunningTradeBatch { repeated RunningTrade batch = 1 }`. **[bundle]**

| #   | Field            | Type                                         | Notes                                                                                                                                                                                        |
| --- | ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `websocket_time` | `google.protobuf.Timestamp`                  | Server send time                                                                                                                                                                             |
| 2   | `stock`          | string                                       | Stock code                                                                                                                                                                                   |
| 3   | `price`          | double                                       | IDR                                                                                                                                                                                          |
| 4   | `volume`         | double                                       | **Shares**, per **[ofs]**: lots = volume / 100. `haka`'s Android doc says lots. Confirm in DevTools.                                                                                         |
| 5   | `action`         | `TradeType`                                  | `1` BUY, `2` SELL, `0` unspecified. This is the aggressor side. **[ofs]** measured 94.7% / 8.4% buy share for 1 / 2, and saw the field absent for the closing auction and negotiated blocks. |
| 6   | `is_global`      | bool                                         | Meaning unconfirmed (foreign flag?)                                                                                                                                                          |
| 7   | `time`           | `google.protobuf.Timestamp`                  | Trade time, as `seconds` (int64) plus `nanos` (int32) (**[bundle]** module `27251`). The precision of real values is unverified.                                                             |
| 8   | `change`         | `Change { double value; double percentage }` |                                                                                                                                                                                              |
| 9   | `trade_number`   | **int32**                                    | Trade id. **[ofs]** dedups reconnect backfill on it. Whether it is unique per stock or per market, and per day, is unverified.                                                               |
| 10  | `market_board`   | `BoardType`                                  | `1` RG, `2` TN, `3` NG                                                                                                                                                                       |
| 11  | `value`          | double                                       | price × volume                                                                                                                                                                               |

**The websocket record has no buyer or seller broker field.** This comes from the schema, and **[ofs]** `docs/protocol.md` reports the same from captured frames. The REST tape (section 3) does carry `buyer`/`seller`, but only **[mcp]** has observed it, and only on a closed market. **[mcp]** `src/core/market.ts` states that IDX stopped broker codes in live running trade on 6 December 2021. That claim is not verified here.

### Whole-market subscription

- The web app's running-trade widget defaults to `stock: { type: AllStock, selected: ["*"] }`, and it sends the active instances' symbols as `runningTradeBatch` in the channel message. **[bundle]** `9293.5f722a92ed0608ae.js`, modules `37775` and `5386`.
- **[haka]** `websocket/client.go` subscribes with `RunningTradeBatch: ["*"]` and `Watchlist: ["*"]` and runs on the whole market.
- The bundle builds the channel message as one cumulative `WebsocketChannel` (liveprice, intraday, orderBook, iepiev, runningTradeBatch and the rest). It resends it, debounced by 100 ms, whenever the page's set of subscriptions changes. A new subscribe therefore replaces the previous one; it does not add to it. That reading comes from the code, so confirm it in DevTools.

### Intraday channel

`intraday` (v1) is `Intraday { stock_code, datetime (string), open, high, low, close, volume, change, lot }`. `intraday_v3` is `{ symbol, timestamp (Timestamp), open, high, low, close, volume, change, change_percentage }`, where each value is a wrapped numeric message. **[bundle]** The schema does not show what bar size these carry. It is probably the current 1-minute bar. Confirm in DevTools.

### Keepalive and reconnect (what the web app does)

From **[bundle]** module `5386`:

- The app sends `WebsocketRequest { ping: { message: "ping" } }` whenever 15 s pass with no inbound frame, and closes the socket if the pong takes longer than 13 s.
- On reconnect it backs off exponentially, `1000 × 2^n` ms, up to 4 tries. If the tab was hidden for more than 30 minutes, it reconnects from scratch.
- On `error.code == 401` it re-authenticates up to 3 times.
- **[ofs]** reports that the server drops a socket that sends no app-level ping, and that a stale token gets a short `you are not authorized` frame. **[ofs]** also reports that a reconnect replays about 40 recent trades, so dedup on `trade_number` is required.

## 2. Auth

- After the socket opens, the app calls `GET https://exodus.stockbit.com/auth/websocket/key` (`getWSTradingKey`) with the session bearer. It then sends `WebsocketRequest { key, user_id: String(user.id), access_token }`, and sends the same three fields again with every channel update. **[bundle]** `47940-…` module `86602` and `9293-…` module `5386`. **[haka]** `auth/auth.go` uses the same key route.
- The websocket handshake itself carries no auth. Browsers cannot set an `Authorization` header on `new WebSocket`, and **[ofs]** connects with only `Origin: https://stockbit.com` and the `web` subprotocol. `haka` sends a bearer header from Go, but that header is not needed.
- **Where the session lives:** a zustand store persisted through js-cookie to a **first-party, JS-readable cookie named `credentialStorage`** on stockbit.com, with a 30-day expiry. The cookie holds `{ access: { token, expired_at }, refresh: { token, expired_at }, user: { id, username, ... } }`. Tabs sync through `BroadcastChannel("credential-store-sync")`. **[bundle]** `27670-a389bdfe555ea203.js` module `64736` and `14275`. REST calls send the token as `Authorization: Bearer <access.token>`; it is not sent as a cookie.
- The access token is an RS256 JWT with about a 24 h lifetime. **[mcp]** `docs/stockbit-api.md` §3 and **[ofs]** both report this.
- **Refresh:** `POST https://exodus.stockbit.com/login/refresh` with `Authorization: Bearer <refresh token>` and an empty body. The web app's axios interceptor does this on a 401 and queues retries. **[bundle]** `15449-…` module `18755`, **[mcp]**. **[mcp]** observed that each refresh rotates the refresh token and retires the old one, and that the web app refreshes on its own. An extension that refreshes would therefore log the user's tab out, or be logged out by it.
- A cookie mode also exists. When the host sets `window.__COMPASS__.authMode === "cookie"`, Chartbit's client switches to an alternate base URL (`exodus.api.stockbit.com` appears in the bundle) with `withCredentials: true`. **[chartbit]** `284.929045985cba3a3e.js` and `7590.57b5af30879b1c33.js`. Which surface turns this on (perhaps the desktop app) is unknown.

## 3. HTTP routes (all `https://exodus.stockbit.com`, bearer auth, JSON)

| Need                        | Route                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1-minute candle history** | `GET /chartbit/{SYMBOL}/price/intraday?from=<unix s>&to=<unix s>&limit=0`, plus `&minutes_multiplier=60` for 1 h bars         | **[chartbit]** `7590.57b5af30879b1c33.js` (`be`) and `8055.7b0d380c0f01d10b.js` (`getIntradayData`). The response is `data.chartbit[]` with `unix_timestamp`, `open`, `high`, `low`, `close`, `lot`, `value`, `frequency` (the volume key is chosen by the chart's volume mode). Rows arrive newest first and the client reverses them. `data.previous_timestamp` gives the next page. |
| Daily candles               | `GET /chartbit/{SYMBOL}/price/daily?from&to&limit=0` (`unixdate` + 25200 s for WIB)                                           | **[chartbit]**                                                                                                                                                                                                                                                                                                                                                                         |
| Company page intraday       | `GET /charts/{SYMBOL}/daily?from&to&interval&chart_type&timeframe`                                                            | **[bundle]** `getCompanyChartIntraday`, **[mcp]** §11d                                                                                                                                                                                                                                                                                                                                 |
| Minutely close series       | `GET /company-price-feed/prices/close?symbol=&interval=1` returns untimestamped close strings                                 | **[mcp]** §4e (observed)                                                                                                                                                                                                                                                                                                                                                               |
| REST running-trade tape     | `GET /order-trade/running-trade?order_by=1&symbols=<SYM>&limit=…` (repeat `symbols`), plus `/order-trade/running-trade/group` | **[bundle]** `getInitRunningTradeV3`. **[mcp]** observed rows with `time`, `action`, `code`, `price`, `lot`, `value`, `market_board`, `buyer`, `seller`, `buyer_type`, `seller_type`, `buy_order_number`, `sell_order_number`. The response is capped at 100 rows from the session open and runs **8–10 min behind**, so it is not usable as a live tape.                              |
| Symbol metadata             | `GET /emitten/{SYMBOL}/info`                                                                                                  | **[chartbit]**, **[mcp]**                                                                                                                                                                                                                                                                                                                                                              |
| Symbol search               | `GET /search?keyword=&page=&type=company` returns `data.company[] { name, desc, exchange, other }`                            | **[chartbit]** `pt`                                                                                                                                                                                                                                                                                                                                                                    |
| Market session times        | `GET /company-price-feed/market-time`, `/company-price-feed/market-time/session`                                              | **[bundle]** (unprobed)                                                                                                                                                                                                                                                                                                                                                                |

**Stock code list:** the public bundle has no route that returns every listed code in one call. The candidates are the paged `/search`, `/emitten/classification/company`, and the screener over the `IHSG` universe (**[mcp]** `src/core/screenerrun.ts`). Another option is to collect codes from the whole-market `running_trade_batch` and `liveprice` streams. Which one the web app's stock picker uses is **unverified**.

## 4. What an MV3 extension can do

| Approach                                                                  | Works?                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chrome.webRequest`                                                       | **No** for data                | It sees the websocket handshake only, never messages or response bodies. **[chrome]** webRequest                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MAIN-world content script on `https://stockbit.com/*` at `document_start` | **Yes, passive.** Recommended. | It shares the page's JS realm **[chrome]**. It can wrap `WebSocket.prototype.send` and `addEventListener` (the **[ofs]** README catcher patches `send` the same way), or attach a `message` listener to `window.datafeedSocket` once it appears. It can decode with the same schema and relay through an ISOLATED-world script to the service worker. It sees exactly what the tab subscribed to, so the tab must have the running-trade page or widget open on "All Stock" (`*`). The page can see and interfere with the script **[chrome]**. |
| Same content script, `fetch` from the page                                | Yes                            | Same-origin context, with the token read from the page's store or the `credentialStorage` cookie. Good for `/chartbit/{SYM}/price/intraday` backfill.                                                                                                                                                                                                                                                                                                                                                                                           |
| Own websocket from the stockbit.com tab (MAIN world)                      | Probably                       | It sends `Origin: https://stockbit.com`, then a subscribe with `key` (from `/auth/websocket/key`), `user_id` and `access_token`. Whether a second concurrent socket per user is allowed, or kicks the tab's socket, is **unverified**.                                                                                                                                                                                                                                                                                                          |
| Own websocket from the service worker                                     | Uncertain                      | Its `Origin` would be `chrome-extension://…`. **[ofs]** sets `Origin: https://stockbit.com`, which suggests the server checks it. Unverified.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `chrome.debugger` + CDP `Network.webSocketFrameReceived`                  | Yes                            | Network is an allowed domain **[chrome]** debugger. Chrome shows a "started debugging this browser" banner (well known, but not stated on the cited page). Heavier than a MAIN-world script.                                                                                                                                                                                                                                                                                                                                                    |
| DOM scraping                                                              | Yes, lossy                     | **[ext]** does this for screener tables. Not suitable for a tape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

In every approach, the extension must **never call `/login/refresh`**: refresh rotates the token, and the web app refreshes on its own. Read the current token from the tab each time, and treat a `401` or `not authorized` reply as "Freshness: stale, owner action needed".

## 5. Owner must confirm in DevTools (signed-in tab, market open)

1. Network → WS → `wss-jkt.trading.stockbit.com/ws`. Confirm the `web` subprotocol and binary frames, and that `window.datafeedSocket` is set in the console.
2. On the running-trade page with "All Stock", confirm the outbound frame has `running_trade_batch: ["*"]`, and that inbound `running_trade_batch` frames cover many stock codes. Measure the peak frames/s and trades/s.
3. Check that `volume` is in shares or in lots, by comparing a print with the UI's lot column.
4. Check the precision of `time` (`nanos` non-zero?), and whether `trade_number` is unique per stock or per market, and resets daily.
5. Check whether `is_global` means foreign.
6. Check whether any broker code appears on live prints, on the websocket or on the REST tape, during an open session.
7. Check the `intraday` / `intraday_v3` bar size, and whether the chart page subscribes to it.
8. Confirm the `/chartbit/{SYM}/price/intraday` response shape and how far back `from` reaches for 1-minute bars.
9. Find which request fills the stock picker (the stock code list source).
10. Test whether opening a second socket with the same `key`/`access_token` disconnects the tab's socket.
11. Check whether `credentialStorage` is HttpOnly. js-cookie writes it from JS, so it should not be.
