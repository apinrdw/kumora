# Relay

What the relay extension and the dashboard Worker must agree on: the IDX trading schedule, the ingest envelope, and the viewer protocol's version. Words from `apps/dashboard/GLOSSARY.md`: **relay**, **feed**, **market phase**, **trade number**, **stock code**, **recorded day**.

## Language

### Schedule

**Trading day**:
A WIB calendar date the exchange trades on: Monday to Friday, except the year's holidays. Every date belongs to one baked year; a date in a year with no entry fails rather than guessing.
_Avoid_: business day, market day

**Holiday**:
A weekday the exchange does not trade, from IDX's yearly announcement. 31 December is always one.
_Avoid_: day off

**Expects trades**:
Whether a stretch of the trading day should print running trades: session 1, session 2, post-trading, and the minute each auction matches in (08:58 and 16:00). A quiet feed in any other stretch is still live.
_Avoid_: active, open

**Streaming hours**:
08:40–16:35 WIB on a trading day, breaks included: when the relay holds its broker sockets open.
_Avoid_: market hours

**Seal**:
17:00 WIB on a trading day, when the day becomes a recorded day and stops changing.
_Avoid_: close, finalize

### Ingest

**Ingest envelope**:
One message from the relay to the dashboard: the feed, the connection, when it was received, and the feed's raw frames, unparsed. An Ajaib envelope also names the stream its frames came from, the trade tape or an on-demand stream; only the tape's frames are signs of life. A connection's buffered frames go up before its `closed` status; its other statuses go up at once, ahead of frames still batched. Also the ingest token, the daily stock code list, and feed status events travel as envelopes. The token is the socket's first envelope, due within 10 s of the socket opening; the dashboard closes a socket still without it with `4408`, which the relay treats as a dropped socket.
_Avoid_: packet, batch

**Connection**:
One of the two sockets, A or B, the relay holds to one feed.
_Avoid_: socket (for the label), tab

**Raw frame**:
One websocket message exactly as the broker sent it: Stockbit protobuf bytes or Ajaib JSON text. Only the dashboard Worker decodes it.
_Avoid_: tick, event

**Feed status event**:
The relay's report that a connection opened, closed, or answered a ping. A ping reply counts as a sign of life.
_Avoid_: heartbeat

**Backfill request**:
The dashboard asking the relay to fetch a range of trade numbers it missed.
_Avoid_: replay, resync

**On-demand codes**:
The stock codes the relay keeps subscribed on Ajaib: every code a viewer has selected or in a watchlist.
_Avoid_: subscriptions

**Protocol version**:
The number an ingest envelope or a viewer message carries. The dashboard accepts the current and the previous ingest version, and only the current viewer version; a mismatch closes the socket with `4426`.
_Avoid_: schema version, API version

### Viewer

**Selection**:
The page's `Select` message: its selected stock code and watchlist. Sent on every connect and every change; the trading-day Durable Object answers each with a snapshot. The object reads a viewer message only up to 200,000 UTF-16 units, which the largest `Select` fits, and closes a longer one with `1011` unread.
_Avoid_: subscribe

**Snapshot**:
What a viewer starts from after each selection: the selected code the `Select` named, the 200 newest running trades ascending by trade number, the selected code's candles, footprints and order book, the selected and watchlist codes' Day states and indicative prices, and the market conditions. The chart and the order book take only a snapshot of their own code, since one answering an earlier selection can arrive after the page moved on.
_Avoid_: initial state

**Delta**:
The running trades that reached the trading-day Durable Object in the last ~250 ms, ascending by trade number, sent to every viewer that has a snapshot. A late trade can sort below trades the viewer already holds.
_Avoid_: update, patch

