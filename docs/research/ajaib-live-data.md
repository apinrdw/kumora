# How Ajaib's web app gets running trades, 1-minute candles and stock codes

Research for [#40](https://github.com/apinrdw/kumora/issues/40), child of the map [#38](https://github.com/apinrdw/kumora/issues/38). Read 2026-11-06.

Nobody signed in to Ajaib for this. The facts come from three kinds of source:

1. **Ajaib's public web bundle.** The `trade.ajaib.co.id` HTML, its `/__ENV.js`, and the 142 JS chunks it loads from `storage.googleapis.com/ajaib-prd-platform-web-trading-assets/assets/`. The entry chunk is `index-CYGRWyZA.js` and the app version string is `v1.13.0`. Ajaib ships new hashes on every release, so the chunk names below go stale. The string literals quoted here (paths, stream names, field names) are what to search for in a newer bundle.
2. **Unauthenticated probes.** WebSocket upgrades and HTTP GETs sent without cookies, made on 2026-11-06.
3. **Earlier captures.** The owner's own earlier project, [`apinrdw/orca-trader-monorepo`](https://github.com/apinrdw/orca-trader-monorepo), is private. Its issue #91 (resolved 2026-10-15) and its code at `4b7b18f` (2026-10-22) record a live MV3 extension that captured Ajaib's whole-market tape. Two public GitHub projects also call Ajaib's endpoints.

Each claim below names its source. Claims marked **inferred** are my reading of minified code. Claims marked **confirm** need the owner to check them in DevTools.

## Answer

- **Web app:** `https://trade.ajaib.co.id/` ("Ajaib Trade"). The same codebase also ships as the Tauri desktop app "Ajaib Terminal". The older hosts `invest.ajaib.co.id` and `login.ajaib.co.id` return a Cloudflare challenge page to scripts.
- **Running trades (live):** a JSON-over-WebSocket stream. From the current bundle, the web build connects to `wss://stream.ajaib.co.id:8009/ws/trade` and sends `{"method":"SUBSCRIBE","id":<user id>,"stream":"TRADE","streamObject":"*"}` to get the whole market. A same-origin path, `wss://trade.ajaib.co.id/ws/stock/trade`, also accepts upgrades, and the owner's earlier extension used it successfully in Sep to Oct 2026.
- **Running trades (backfill):** `GET https://ht2.ajaib.co.id/api/v1/stock/detail/running_trades/` for the whole market, and `.../v1/stock/detail/{CODE}/running_trades/` for one stock code. Both are paged by `last_timestamp` (epoch ms), `page` and `page_size`.
- **Trade identity:** `tradeNum` is an 18-character string: `YYYYMMDD` followed by a 10-digit sequence that is market-wide for the day. Ajaib's own code dedupes the whole-market tape on it. This is the dedupe key.
- **Time precision:** `tradedAt` is an ISO string with a `+07:00` offset and a millisecond field that has always been `.000`. In effect it is whole seconds. `updateTime` is epoch ms, but it records when the message was stamped, not when the trade happened.
- **Broker codes:** the live `TRADE` messages carry `buyer`, `seller`, `buyerType` and `sellerType`. In the October 2026 whole-market capture they were empty (`""` and `null`). The REST rows have `buyer`, `seller`, `buyer_type`, `seller_type` and `buyer_color` columns, and the UI renders them, so REST may fill them in. **Confirm.**
- **1-minute history:** `GET https://ht2.ajaib.co.id/api/v1/stock/detail/{CODE}/candlestick/?resolution=1M&to=<epoch ms>&countback=<n>`, where `1M` means one minute and `1MO` means one month. The response is JSON `result.points[]` with `from_time`, `open`, `high`, `low`, `close` and `volume`.
- **Live candle:** the chart takes its live updates from the `PRICE` stream on `/ws/price`, not from trades.
- **Stock code list:** `GET https://ht2.ajaib.co.id/api/v1/stock/data/list/` returns `results[]` with at least `code` and `name`. The app caches it for one hour.
- **Auth:** a JWT access token with a refresh token. On the web both are JavaScript-set (not HttpOnly) cookies on `.ajaib.co.id`. HTTP calls send `Authorization: jwt <access token>`. The WebSocket upgrade is authenticated by cookies, because a browser WebSocket cannot set headers.
- **Extension access:** the extension can read the page's own socket passively by wrapping `window.WebSocket` in a MAIN-world content script. It can also open its own socket from a content script in the Ajaib tab, which is what the earlier extension did. It cannot connect from the service worker: Ajaib's edge returned 403 to a `chrome-extension://` origin. `chrome.webRequest` cannot see frame contents.

## The web app and its hosts

Source: `https://trade.ajaib.co.id/` and `https://trade.ajaib.co.id/__ENV.js`, fetched 2026-11-06.

`__ENV.js` sets `window.__RUNTIME_ENV__`. The market-data entries:

| Key | Value |
|---|---|
| `VITE_PUBLIC_API_URL` | `https://ht2.ajaib.co.id/api/` |
| `VITE_PUBLIC_STOCK_WEBSOCKET` | `wss://stream.ajaib.co.id:8009` |
| `VITE_PUBLIC_CENTRIFUGO_WS` | `wss://edge-events.ajaib.co.id/connection/websocket` |
| `VITE_PUBLIC_CENTRIFUGO_WS_PRIVATE` | `wss://edge-events-private.ajaib.co.id/connection/websocket` |
| `VITE_PUBLIC_WATCHLIST_WEBSOCKET` | `wss://realtime.ajaib.co.id` |
| `VITE_PUBLIC_SHARED_COOKIE_DOMAIN` | `.ajaib.co.id` |

`VITE_PUBLIC_USE_WS_PROXY` is not set. That decides which WebSocket URL the web build uses (next section).

The Centrifugo sockets carry account events, not market data. The bundle subscribes to `order_status_change:id_stock#<id>` and `portfolio:id_stock#<id>` (chunk `useKycStatus-*.js`). They do not matter for Market Live.

The HTML has two `<meta name="disable-extension-feature">` tags, with the values `read-dom` and `execute-script`. I found no Chrome documentation for this meta name, so it is probably inert. **Confirm** that a content script still runs. The response's CSP sets only `frame-ancestors` and `frame-src`, with no `script-src`, so nothing in the CSP blocks an injected script.

## Market-data WebSocket

### URL

Source: chunk `apiClient-*.js`, de-minified:

```js
const isWebDirect = () => !isTauri() && !useWsProxy()   // useWsProxy = VITE_PUBLIC_USE_WS_PROXY === "true"
const wsUrl = (name) => isTauri() || isWebDirect()
  ? `${VITE_PUBLIC_STOCK_WEBSOCKET}/ws/${name}`
  : `/ws/stock/${name}`
```

The tape uses `wsUrl("trade")` and the chart uses `wsUrl("price")`. With today's `__ENV.js`, the web build connects to `wss://stream.ajaib.co.id:8009/ws/trade` and `/ws/price`. If Ajaib turns on `USE_WS_PROXY`, it uses the same-origin `wss://trade.ajaib.co.id/ws/stock/trade` instead.

Unauthenticated HTTP/1.1 upgrade probes on 2026-11-06, all with `Origin: https://trade.ajaib.co.id`:

| URL | Result |
|---|---|
| `wss://stream.ajaib.co.id:8009/ws/trade` | `401 Unauthorized` (`server: istio-envoy`) |
| `wss://stream.ajaib.co.id:8009/ws/price` | `401 Unauthorized` |
| `wss://trade.ajaib.co.id/ws/stock/trade` | `101 Switching Protocols` (`server: cloudflare`) |
| `wss://trade.ajaib.co.id/ws/stock/price` | `101 Switching Protocols` |

Both URLs work. The direct host checks auth at the upgrade. The proxy path upgrades first and presumably checks auth afterwards; I did not subscribe without credentials to find out. **Confirm** in DevTools → Network → WS which URL the signed-in tab opens today.

### Encoding and protocol

Sources: chunks `websocket-*.js`, `price-ws-*.js` and `index-*.js`; owner's issue #91; a fixture in `orca-trader-monorepo` at `4b7b18f`, `apps/dashboard/tests/ingest/parse-frame.test.ts`.

- Frames are JSON text, not protobuf. The bundle runs `JSON.parse` on string frames, and the earlier capture parsed 107,319 frames with none failing (`docs/specs/ajaib-running-trade-ingest.md` §5 in that repo).
- **Subscribe:** `{"method":"SUBSCRIBE","id":<userDetails.id, default 2>,"stream":"TRADE","streamObject":"*"}` for the whole market, or `"streamObject":"<CODE>"` for one stock code. Send `"UNSUBSCRIBE"` to stop. The `id` is the account id, which is also the JWT `sub`. The earlier extension added `"count":5`. The bundle sends `count` only for `INDICATIVE`.
- **Other streams on the same server:** `PRICE` (per code, used by the chart), `INDICATIVE` (with `count:20`), an order-book stream, and `ORDER_BOOK_CUSTOM`. That last name comes from `azdharsyahputra/proxyai` at `a39ff44`, `go-proxy/debug/debug_ws.go`.
- **Ack:** `{"id":<id>,"result":"subscribe successful"}`.
- **Heartbeat (web build):** if no message arrives for 10 s, the page sends `{"method":"SUBSCRIBE","streamObject":"PING-WEB"}`. The replies are `{"id":null,"result":"subscribe successful"}` or `{"id":null,"result":"already have active subscription for PING-WEB"}`. If no message arrives for 13 s, the page closes and reconnects. Server keepalives arrive as `{"streamObject":"PING <epoch ms>"}` (issue #91).
- **Reconnect:** before each reconnect, the web build refreshes the access token and rewrites the `ajaib-token` cookie (inferred from `shouldReconnect` in `websocket-*.js`).
- **No replay:** a reconnect receives only new fills (issue #91, item 5). Use the REST backfill to fill gaps.
- **Volume:** 1.33M to 2.15M fills per trading day, 2026-09-21 to 2026-10-14 (issue #91, item 6).

### Running-trade message fields

This is a verbatim live fill from the 2026-10-15 capture, quoted in the fixture above. It contains no account data.

```json
{"ticker":"MEJA","updateTime":1792033042261,"buyer":"","seller":"","buyerType":null,"sellerType":null,"type":"SELL","price":138.0,"lot":21.0,"value":289800,"tradedAt":"2026-10-15T09:57:22.000+07:00","tradeNum":"202610150000499855","returnPct":-2.82,"co":340,"s":345,"eb":5}
```

| Field | Meaning | Source |
|---|---|---|
| `ticker` | Stock code | bundle maps it to `stock_code` |
| `type` | `"BUY"` or `"SELL"`, the aggressor side | bundle filters frames on this value |
| `price` | Price in rupiah. A float in JSON, integral in practice | fixture |
| `lot` | Lots, where 1 lot is 100 shares. A float in JSON | fixture |
| `value` | `price × lot × 100` | issue #91 |
| `returnPct` | Change from the previous close, in % | bundle maps it to `return_pct` |
| `tradedAt` | Trade time, ISO with `+07:00`. Milliseconds are always `.000`, so precision is effectively 1 s | fixture, issue #91 |
| `tradeNum` | `YYYYMMDD` plus a 10-digit market-wide daily sequence. Keep it as a string: as a number it exceeds the safe-integer range | issue #91 |
| `updateTime` | Epoch ms when the message was stamped | bundle uses it for `timestamp` and for candle bucketing |
| `buyer`, `seller`, `buyerType`, `sellerType` | Broker codes and their type. Empty in the whole-market capture | fixture; bundle defaults them to `""` |
| `co`, `s`, `eb` | Undocumented numbers. The bundle reads `s` as a latency term for its own `wsFreshness` metric, so `s` is probably a server-side delay in ms (**inferred**) | `websocket-*.js` |

Ajaib's own whole-market view dedupes on `trade_num` alone, keeping 100 rows (`index-*.js`, near `tw=e=>({stock_code:e.ticker,trade_num:e.tradeNum,...})`). The per-stock view falls back to `` `${stock_code}-${timestamp}` `` when `trade_num` is missing.

For the merge with Stockbit: if Stockbit's tape carries the same IDX trade number, `tradeNum` is an exact cross-feed key. Otherwise only `(code, second, price, lot, side)` remains, and that key collides when the same stock has several fills in one second. That depends on #39.

### When the page's socket is live

- The page subscribes to `TRADE:*` only while a Running Trade widget is in "all stocks" mode. A reference counter shares one subscription across widgets and delays the subscribe by 300 ms. Pausing the widget, or closing it, sends `UNSUBSCRIBE` (`index-*.js`, `QC.subscribe("TRADE:*", ...)`).
- Every socket is disabled while `isIdleLocked` is true. `lockIdle()` also clears the access token (`websocket-*.js`, `apiClient-*.js`). The earlier capture saw the token go stale after about 4 minutes idle, after which the tab landed on `/pin` (issue #91, item 8).
- The page reports a stream as stale after 60 s without data. This comes from a market-phase-aware check in the bundle.

## HTTP endpoints

Base URL: `https://ht2.ajaib.co.id/api/`. Unauthenticated GETs from curl get a Cloudflare challenge page (`403`). From inside the signed-in tab they work as the app's own calls do.

| Purpose | Request | Response shape |
|---|---|---|
| Whole-market running trades | `GET v1/stock/detail/running_trades/?last_timestamp=<ms>&direction=DESC&page=<n>&page_size=<n>[&side=BUY\|SELL&min_lot=&min_price=&max_price=]` | `results[]` of `{stock_code, trade_num, lot, price, side, date, time, buyer, seller, buyer_type, seller_type, return_pct, market_type, timestamp, buyer_color, seller_color}`, plus `has_next` or `next` |
| One code's running trades | `GET v1/stock/detail/{CODE}/running_trades/` with the same query | same |
| Candles | `GET v1/stock/detail/{CODE}/candlestick/?resolution=1M&to=<ms>&countback=<n>` | `{err_code:"EC0000000", result:{points:[{from_time, open, high, low, close, volume}]}}` |
| Stock code list | `GET v1/stock/data/list/` | `results[]` with `code` and `name`, plus fields not read here |
| Trading-day times | `GET v1/stock/data/trading-day/time/` | session times; not read in detail |

Sources: chunk `index-*.js` for running trades and trading-day times, and chunk `Chart-*.js` for candles and the list.

Notes on the candles endpoint (from `Chart-*.js`):

- Resolution codes: `1`→`1M`, `5`→`5M`, `10`→`10M`, `15`→`15M`, `30`→`30M`, `60`→`1H`, `1D`→`1D`, `1W`→`1W`, `1M` (TradingView month)→`1MO`.
- The app never asks for fewer than 500 bars, and it sends no `to` for the current day.
- `from_time` is treated as epoch ms (**inferred**: the code adds 9.5 h in ms to daily bars).
- The TradingView datafeed stops paging intraday resolutions after 93 days. That limit lives in the client, and the server may allow more.
- Live bar updates come from `PRICE` frames: `ticker`, `open`, `hi`, `lo`, `price`, `tradableVolume` (cumulative) and `updateTime`. The app buckets by `floor(updateTime / 60000)` and takes each bar's volume as the change in `tradableVolume`.

**Confirm** whether REST running-trade rows carry broker codes for the whole market. **Confirm** whether `time` and `date` carry milliseconds.

## Auth

Source: chunk `apiClient-*.js`.

- **Token storage on the web:** tokens are stored as cookies set by JavaScript (js-cookie), with `Secure`, `SameSite=Lax` and domain `.ajaib.co.id`. Because JavaScript sets them, they are not HttpOnly. The cookie names are `trade_access_token`, `trade_refresh_token`, `trade_pin_token`, `trade_pin_refresh` and `trade_hashed_email`. The access token is also copied into an `ajaib-token` cookie for the direct WebSocket host. The tokens are JWTs; the app reads `exp`, and `sub` is the account id.
- **HTTP headers:** each HTTP call sends:
  - `Authorization: jwt <access token>`
  - `X-Platform: WEB`
  - `X-Product: stock-mf`
  - `x-app-mode: PRO`
  - `X-Device-Name: Web <browser>`
  - `X-Device-Signature`
  - `X-Ht-Ver-Id` (the hashed email)
  - `x-web-version`
  - `Accept-Language: id`
- **Request signing:** POST, PUT and DELETE also carry an ECDSA signature from a device key held in the browser (`x-device-request-signature`, `x-device-nonce`, `x-device-timestamp`). GETs are not signed. Every market-data call above is a GET.
- **Refresh:** `POST v7/refresh/` with `Authorization: jwt <refresh token>` returns `access_token` and `refresh_token`. Once the refresh token expires, the app falls back to the PIN-token path (`v7/refresh/pin/`) and locks the session until the PIN is entered again.
- **Old cookie names:** `aa-ardanirahman/wina_idx` at `06308f9` (2023-01-17), `brokers/ajaib/running_trade.py`, connected to `wss://stream.ajaib.co.id:8009/ws/price` with cookies named `access_token` and `refresh_token`. Those names are older than the current `trade_*` names.

An extension should never copy, store or forward these tokens. Both options below leave them in the browser that holds them.

## Can an MV3 extension read it?

| Approach | Works? | Evidence |
|---|---|---|
| `chrome.webRequest` | Handshake only, no frames | [webRequest docs](https://developer.chrome.com/docs/extensions/reference/api/webRequest) (updated 2026-10-29): "the API does not intercept individual messages sent over an established WebSocket connection" |
| Socket from the service worker | No | Ajaib's edge returned Cloudflare 403 to a `chrome-extension://` origin (issue #91, item 1) |
| Own socket from a content script in the Ajaib tab | Yes, proven Sep to Oct 2026 | The earlier extension (`apps/extension/entrypoints/ajaib.content.ts` at `4b7b18f`) opened `wss://trade.ajaib.co.id/ws/stock/trade` from an isolated-world content script. Cookies authenticated the upgrade. It read the account id from the JWT `sub` in `document.cookie` and sent its own heartbeat |
| Passive tap of the page's socket | Should work; not yet tried | A `"world": "MAIN"` content script at `document_start` ([content_scripts docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)) can wrap `window.WebSocket` before the bundle runs. The bundle calls `new WebSocket(url)` on the main thread, not in a worker. Frames then reach the isolated world through `postMessage` |

Trade-offs:

- **Passive tap:** sees exactly what the page sees. It sends nothing to Ajaib that the page would not send. But it gets `TRADE:*` only while an "all stocks" Running Trade widget is open and not paused. It goes silent whenever the page idle-locks.
- **Own socket:** independent of the page's layout. But it is an extra connection per tab, it needs its own heartbeat, and it depends on the `/ws/stock/trade` proxy path (or the direct host) still accepting cookie auth. Both approaches stop when the session locks.
- **History:** both approaches still need the REST calls for history and backfill: candles, running trades and the code list. A content script can call them like the page does, with `Authorization: jwt` taken from `trade_access_token`. A simpler option is to observe the page's own responses by wrapping `fetch` or `XMLHttpRequest` in the MAIN world. Whether a GET without the device headers is accepted is unverified.

## What the owner must confirm in DevTools

Do this on `trade.ajaib.co.id`, signed in, during trading hours.

1. Network → WS: which URL the tab opens for trades. Check whether it is `stream.ajaib.co.id:8009/ws/trade` or `trade.ajaib.co.id/ws/stock/trade`, and which cookies the upgrade sends.
2. In the Messages pane, with an "all stocks" Running Trade widget open: check that the subscribe frame and the fill fields match the table above. Check whether `buyer` and `seller` are still empty, whether `tradedAt` milliseconds are still `.000`, and what `co`, `s` and `eb` look like.
3. Network → Fetch/XHR: the responses of `running_trades/` (whole market) and `candlestick/?resolution=1M`. Check for broker codes in the rows, check the unit of `from_time`, and find the largest `countback` the server honours.
4. The `v1/stock/data/list/` response: the full field list, and whether it includes suspended and special-notation codes.
5. That a MAIN-world content script runs despite the `disable-extension-feature` meta tags.
6. How long an idle signed-in tab keeps its session before `/pin`, and whether the Market Live tab can show that state as a **Freshness** drop.

Remove the account id and every token from anything you copy out of DevTools.
