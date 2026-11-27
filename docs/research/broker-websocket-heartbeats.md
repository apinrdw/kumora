# How Stockbit's and Ajaib's websockets ping, pong and time out

Research for [#59](https://github.com/apinrdw/kumora/issues/59), child of the map [#38](https://github.com/apinrdw/kumora/issues/38). Read 2026-11-06.

It sets the heartbeat tick and the stagger between connection A and connection B for the relay chosen in [#43](https://github.com/apinrdw/kumora/issues/43): own sockets opened from content scripts in the broker tabs, with every clock in the service worker.

## Answer

**On both sites the client pings, and only when its socket has gone quiet.** Neither server sends an app-level ping. Both pings are app-level messages. A browser cannot send a protocol ping, and neither server needs one.

|                         | Stockbit                                                                                                           | Ajaib                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socket                  | `wss://wss-jkt.trading.stockbit.com/ws`, subprotocol `web`, protobuf                                               | `wss://stream.ajaib.co.id:8009/ws/trade`, `/ws/price`, `/ws/indicative`, JSON                                                                                                                         |
| Who pings               | Client                                                                                                             | Client                                                                                                                                                                                                |
| Ping                    | `WebsocketRequest { ping: { message: "ping" } }`, 8 bytes `22 06 0a 04 70 69 6e 67`                                | `{"method":"SUBSCRIBE","streamObject":"PING-WEB"}`                                                                                                                                                    |
| Pong                    | Case 2 `ping`, `PingResponse { message: "pong" }`, 8 bytes `12 06 0a 04 70 6f 6e 67`                               | `{"id":null,"result":"subscribe successful"}`, then `{"id":null,"result":"already have active subscription for PING-WEB"}`. On `/ws/indicative`: `{"id":null,"result":"invalid subscription object"}` |
| Page's ping rule        | After 15 s with no inbound frame. Checked every 1 s, so about every 16 s on a quiet socket                         | After 10 s with no inbound frame, and 10 s since the last ping. Checked every 1 s, so about every 11 s. Plus one ping 1 s after open                                                                  |
| Page's dead-socket rule | Closes 13 s after a ping with no pong                                                                              | Closes after 13 s with no inbound frame                                                                                                                                                               |
| Page's reconnect        | `1000 × 2^n` ms, 4 tries; new `auth/websocket/key` each time; no reconnect while the tab is hidden                 | Every 3 s, no limit; refreshes the token first                                                                                                                                                        |
| Server idle timeout     | Unknown. A third-party client reports a silent drop without pings, with no number. Pinging every 10–25 s is proven | About **30 s** after the last message when the client sends nothing (owner's capture, 2026-10-16)                                                                                                     |
| Periodic closes         | 1006 after 51 and 61 min. No fixed lifetime. Cause unknown                                                         | One recorded busy-hour close 1000 at 3 m 15 s. Not shown to be periodic. Cause unknown                                                                                                                |

**Recommendation:**

- **Tick: 10 s**, from the service worker. On each tick, a socket that has received nothing since the last tick sends its site's ping. A socket whose ping got no reply by the next tick is dead: reopen it. A 10 s tick keeps Ajaib's ~30 s idle close two ticks away, so one missed tick does not drop the socket. A 20 s tick would leave less than one tick of slack.
- **Stagger: one tick (10 s) on both sites**, counted from A's first data frame, and never two opens in the same tick. Neither site shows a fixed socket lifetime, so a phase offset buys nothing yet. The stagger keeps the two handshakes (and on Stockbit, the two key fetches) apart. If the Ajaib soak in [#50](https://github.com/apinrdw/kumora/issues/50) shows a fixed lifetime T, change Ajaib's stagger to T/2.

The rest of this note gives the evidence, the reasons, and the checks that still need a live session.

## Sources

| Tag          | Source                                                                                                                                                                                                                          | Pinned at                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **[sb]**     | stockbit.com Next.js bundle, `buildId` `v3.54.12`. Socket module `5386` in `9293.5f722a92ed0608ae.js`; protobuf descriptors in `20793-dcf9c3587c81dd92.js`                                                                      | fetched 2026-11-06                         |
| **[aj]**     | trade.ajaib.co.id Vite bundle, entry `index-DKOtYJk3.js`. Socket code in `websocket-BahpgoPk.js`, `PRICE` hook in `price-ws-DdNlptn5.js`                                                                                        | fetched 2026-11-06                         |
| **[lot]**    | [`r3ven7/lot`](https://github.com/r3ven7/lot), CDP captures of Stockbit's web socket from 2026-04-17, in `stockbit_orderbook_service/research/captures/ws_capture_output/*_raw_*.ndjson`                                        | `1a66f4c68a83b2764d3ee66770b98848e1334857` |
| **[ofs]**    | [`silenccy/orderflow-station`](https://github.com/silenccy/orderflow-station), `docs/protocol.md` and `orderflow/feed.py`                                                                                                       | `39f4410ea0702bb5209f7a765e6b8e1f5e490173` |
| **[haka]**   | [`nofendian17/stockbit-haka-haki`](https://github.com/nofendian17/stockbit-haka-haki), `websocket/client.go`, `websocket/manager.go`                                                                                            | `18fe1e9ccd6b5437ad4e84a23decc08c75e4bad8` |
| **[orca]**   | The owner's earlier project `apinrdw/orca-trader-monorepo` (private): issues #91, #125, #126, #128, and `apps/extension/lib/socket-clock.ts`                                                                                    | `4b7b18f`                                  |
| **[#48]**    | Owner's DevTools captures on [#48](https://github.com/apinrdw/kumora/issues/48) and [#50](https://github.com/apinrdw/kumora/issues/50)                                                                                          | 2026-11-06                                 |
| **[chrome]** | [Timer throttling in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88), [extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) | read 2026-11-06                            |

The bundles are the primary source for what each site's own client does. Server behaviour can only be observed, so it comes from captures: **[lot]**, **[orca]** and **[#48]**.

## 1. Stockbit

### What the web app does

All from **[sb]** module `5386` (the `heartbeatDuration` prop defaults to `15e3`):

- Every inbound frame sets `lastMessageAt = Date.now()`.
- A `setInterval` runs every 1 s. If more than 15 s have passed since the last inbound frame, it sends `new WebsocketRequest({ ping: { message: "ping" } })` and starts a 13 s timer that calls `socket.close()`.
- The app registers a listener on the inbound `ping` case that clears that timer. So the server's case 2 frame is the pong.
- When the tab becomes visible, the app sends a ping at once. If nothing arrived for more than 45 s (`3 × 15 s`), it closes the socket instead. If the tab was hidden for more than 30 min, it tears the socket down and opens a fresh one.
- On `close`: if the tab is hidden, the app only marks itself disconnected and waits for `visibilitychange`. Otherwise it reconnects after `1000 × 2^n` ms, up to 4 tries, then reports "Maximum reconnection". Each open fetches a new key from `auth/websocket/key` and resends the channel message.

The schema (**[sb]** `20793-…`): `PingRequest { string message = 1 }` is request field 4. `PingResponse { string message = 1 }` is response case 2. **[haka]**'s proto, taken from the Android app, has a `Timestamp` in both instead. The web app uses the string form.

### What the wire shows

**[lot]** captured Stockbit's own page over CDP. On every quiet socket, the page sent `22 06 0a 04 "ping"` at 15, 31, 47, 63 … s after open, and the server answered `12 06 0a 04 "pong"` within the same 0.1 s. On sockets with order-book traffic, no ping went out at all. No capture shows a server frame on case 2 without a ping before it. So **the client initiates, and only when the socket is quiet.**

### Server idle timeout

Unknown.

- **[ofs]** `docs/protocol.md`: "The client must send an app-level ping or the server silently drops the connection". It sends the ping every 10 s and turns off the library's protocol ping. It gives no timeout.
- **[haka]** pings every 25 s (`StartPing(25 * time.Second)`) and runs for long periods.
- So a ping every 10–25 s is proven to keep a socket alive. The server's limit without pings is not measured.

### The 1006 drops

From **[#48]**: the soak socket dropped with 1006 after 51 min, and the page's own socket after 61 min. A new socket opened at 15:50:10 dropped 1 s later, before any frame.

- **Not a ping timeout.** The page's own timeout calls `socket.close()`, which ends in a clean close, not 1006. 1006 means the TCP connection ended with no close frame: a server or proxy abort, a network change, or Chrome unfreezing a frozen tab. **[orca]** #125 found that from Chrome 151, a frozen tab's websocket gets `close` 1006 when the tab unfreezes.
- **Not a fixed lifetime.** 51 and 61 min differ, and the page's socket kept running through 15:50.
- **The page's pings in the soak were probably visibility pings.** The page pings on its 1 s timer only after 15 s of silence, and a socket with a whole-market tape is rarely silent that long during trading. The two pings seen (15:01 and 15:39) fit the visibility handler, which pings each time the tab becomes visible. So throttled ping timers probably did not cause the drops. **Needs check** against the tab's activation times.
- **The page's 1 s reconnect means the tab was visible then.** The app does not reconnect while hidden. **Needs check.**

## 2. Ajaib

### What the web app does

All from **[aj]** `websocket-BahpgoPk.js` (browser path, constants `x = 1e4`, `ae = 13e3`, `C = 1e3`, `T = 3e3`):

- 1 s after open, the app sends `{"method":"SUBSCRIBE","streamObject":"PING-WEB"}` once.
- A `setInterval` runs every 1 s (`max(100, 10000 / 10)`). If 13 s have passed since the last inbound frame, it calls `ws.close()`. Otherwise, if 10 s have passed since the last inbound frame and since the last ping, it sends `PING-WEB`.
- Inbound frames equal to `{"id":null,"result":"subscribe successful"}` or `{"id":null,"result":"already have active subscription for PING-WEB"}` count as the pong. The app uses them for round-trip latency and does not pass them on. Any other frame also counts as activity.
- On close, `shouldReconnect` refreshes the access token and returns `true`. The app reconnects after 3 s, with no limit on tries.
- A separate 1 s timer looks for gaps of more than 3 s between its own runs (sleep, or a throttled hidden tab). If it finds one, the next `focus` or `visibilitychange` to visible calls `forceReconnectAll()`, which closes and reopens every socket on the page.
- The Tauri desktop build has a second path. It sends protocol `Ping` frames, expects a `Pong` within 3 s, and answers the server's protocol `Ping`s. So the server handles protocol pings. A browser page cannot send them, and the browser answers server protocol pings by itself.

### What the wire shows

- **[#50]**: on `/ws/indicative`, a quiet socket, the page sent `PING-WEB` about every 11 s. The server answered `invalid subscription object` each time, and the socket stayed open. That matches the 10 s rule plus the 1 s check.
- **[orca]** #126 corrects #91: the archive of 2026-10-16 had **no server `PING` frame**. The server does not ping.
- **[orca]** #126 and #128: the earlier extension sent nothing after its subscribe. Ajaib closed its socket **about 30 s after the last message**, 294 times that day, mostly in quiet stretches. That was on the same-origin path `wss://trade.ajaib.co.id/ws/stock/trade`. The extension then adopted `PING-WEB` after 10 s of silence, timed by the service worker. This kumora relay will use the direct host, so the 30 s figure **needs a check** there.

### The close 1000 at about 3 minutes

**[#48]** recorded one close: the page's trade socket closed with code 1000 at 09:39:25, about 3 m 15 s after open, and reopened about 2 s later with no replay. The token lives 15 min, so expiry did not cause it. The record has no second close, so "every 3 minutes" is not established. **[orca]** #126 also counted five 1–3 s busy-hour reconnects in one day, with no recorded cause.

Candidate causes, none confirmed:

1. **The page's own `forceReconnectAll()`.** A hidden Ajaib tab runs out of timer budget (**[orca]** #125: hidden-page timers share 1% of wall time), so the 3 s gap check fires, and the next focus reopens every socket. This would not touch the relay's own sockets.
2. **The page's 13 s silence close.** Unlikely on `TRADE *`, which carries about 65 trades/s.
3. **A server-side close**, such as a rolling restart or a maximum connection age.

The close code cannot tell these apart: the browser reports the code from the server's close frame, and the server may answer a bare `close()` with 1000. **Needs check:** see section 4.

## 3. The relay's heartbeat

### App-level ping, never protocol ping

A page's `WebSocket` cannot send a protocol ping frame. Both servers accept the app-level ping, and both web apps rely on it. Chrome answers any server protocol ping by itself. So the relay sends each site's app-level ping and nothing else.

### Why the ticks come from the service worker

- Chrome throttles a hidden page's timers, the content script's included: once per second at best, once per minute under intensive throttling after 5 min hidden (**[chrome]** Chrome 88 post), and with no upper bound once the 1% CPU budget runs out (**[orca]** #125). The **[#48]** soak saw 60 s timers stretched to 120 s.
- Websocket messages and Port messages are not throttled (**[orca]** #125, from `frame_scheduler_impl.cc`, and a test where a 1 s content-script timer was held 59 s while Port messages arrived in 0–1 ms).
- A service worker stays alive while events and extension API calls keep coming, and stops after 30 s idle (**[chrome]** lifecycle). The content scripts' frame batches arrive many times a second during trading, so its 10 s interval keeps running. `chrome.alarms` cannot go below 30 s, so the alarm only revives a stopped worker. On its own it is too slow to keep an Ajaib socket alive.

### The tick: 10 s

One `setInterval` of 10 s in the service worker drives both sites. On each tick, for each socket:

1. If the socket received nothing since the previous tick, send its ping: Stockbit's 8-byte `ping`, or Ajaib's `PING-WEB`. Do not ping a busy socket. That matches what each page sends.
2. If the ping sent on the previous tick got no reply, and no other frame arrived, the socket is dead. Reopen it.

Reasons for 10 s:

- **Ajaib closes a silent socket at about 30 s.** With pings 10 s apart, the socket survives one missed or late tick. At 20 s, a tick more than 10 s late drops the socket.
- **Both pages ping at roughly this rate:** Ajaib about every 11 s, Stockbit about every 16 s. **[ofs]**'s 10 s and **[haka]**'s 25 s both work on Stockbit.
- **Dead-socket detection takes at most two ticks (20 s).** The pages detect one in 13 s. The second hot connection carries the feed meanwhile.
- The cost is one Port message per tab per tick, and an 8-byte or 48-byte frame per quiet socket.

The Port keepalive in [#41](https://github.com/apinrdw/kumora/issues/41) asked for one message under every 30 s. A 10 s tick satisfies it.

### The stagger: one tick (10 s)

Open connection A. When A delivers its first data frame, open B on the next tick. After that, never open or reopen both connections in the same tick. If both are down, reopen A, then B a tick later.

Reasons:

- **Neither site shows a fixed socket lifetime.** Stockbit dropped at 51 and 61 min. Ajaib has one close at 3 m 15 s and a few unexplained ones. A phase offset only helps against a fixed lifetime, so a longer stagger buys nothing now.
- **Separate handshakes.** A Stockbit open makes a key fetch and sends a large channel message (690 codes on each channel). A socket opened at 15:50:10 died 1 s after opening. Two opens at once would risk both failing together.
- **Separate failure moments.** With two sockets one tick apart, a drop on one leaves the other streaming. Stockbit drops trade numbers even on an open socket (46 and 143 on [#48]), and Ajaib loses every trade in its reconnect gap, so the second connection is what fills them.
- **If the Ajaib soak in [#50](https://github.com/apinrdw/kumora/issues/50) shows a fixed lifetime T**, set Ajaib's stagger to T/2, so A and B close as far apart as they can. Each socket reconnects after the same delay, so the offset holds.

### Reconnect

- **Stockbit:** fetch a new `auth/websocket/key`, then resend the full channel set. The page waits 1 s, then doubles. The relay can reopen on the next tick.
- **Ajaib:** reopen on the next tick. The page refreshes its token before reconnecting, and the relay reads the cookie the page keeps fresh.
- **[orca]** #128 used make-before-break for a planned reopen: the new socket subscribes first, and the old one closes after the new one delivers. Duplicates are absorbed by the dedupe key in [#44](https://github.com/apinrdw/kumora/issues/44).

## 4. Checks that need a live DevTools session

1. **Ajaib: who closes at about 3 minutes, and how often.** In a MAIN-world probe, wrap `WebSocket.prototype.close` and log each call with a stack, plus `visibilitychange` and `focus` times. Log each close's code, reason, `wasClean` and age, on the page's sockets and on the probe's own sockets. If only the page's sockets close, and right after a focus, the cause is `forceReconnectAll()` and the relay is unaffected. The 90-minute `__kp.ajaibSoakTest` in [#50](https://github.com/apinrdw/kumora/issues/50) gives the close-age distribution.
2. **Ajaib: the idle timeout on the direct host.** Open `stream.ajaib.co.id:8009/ws/price`, subscribe one quiet code, send nothing, and time the close. Repeat with `PING-WEB` every 20 s, then every 10 s.
3. **Stockbit: the idle timeout without pings.** Open a socket during the lunch break, or with one quiet code, send no ping, and time the close. Then confirm a 10 s ping keeps it up for 30 min.
4. **Stockbit: unsolicited case 2 frames.** Count case 2 frames that arrive with no ping before them. **[lot]** saw none.
5. **Stockbit: the cause of 1006.** Log every socket's open time, close time and code across a day. Check whether A and B drop at the same instant (a server or network event) and whether `tabs.onUpdated` reported `frozen` (a frozen tab).
6. **Stockbit: the page's pings at 15:01 and 15:39.** Compare them with the tab's activation times. If they match, the page's 1 s timer never pinged during the soak because the socket was never quiet. Also record which channels the page's socket held then.
7. **Stockbit: the page reconnecting while hidden.** The bundle says it waits for the tab to be visible. The soak saw a 1 s reconnect. Check whether the tab was visible at 15:40:49.
