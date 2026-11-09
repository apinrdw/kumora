# Extension

The relay: an unpacked Chrome MV3 extension that reads the owner's signed-in broker tabs and sends their raw frames to the dashboard's trading-day Durable Object. Words from `packages/relay/GLOSSARY.md` and `apps/dashboard/GLOSSARY.md`: **relay**, **feed**, **ingest envelope**, **ingest token**, **streaming hours**.

## Language

**Broker tab**:
A tab of a broker site (Stockbit or Ajaib) the owner keeps open and signed in. Its content script opens the relay's own sockets from the tab's origin; with no broker tab open, that feed is unavailable.
_Avoid_: page socket, source tab

**Connection**:
One of a broker site's two relay sockets, A or B. B opens on the tick after A's first frame, and at most one connection opens per tick. On Ajaib, connection A (or B) is four sockets, one per stream: the trade tape, whose socket is the connection's freshness, and the three on-demand streams, whose frames go up marked as theirs.
_Avoid_: stream, channel

**Tick**:
The service worker's 10 s heartbeat. A connection quiet since the last tick sends its ping; one still unanswered at the next tick reopens.
_Avoid_: interval, poll

**Target**:
A dashboard the relay sends envelopes to over its own ingest socket: always Production, plus at most one extra target (Staging, a Preview or a Dev stage) set on the options page. The dashboard picks the trading-day object at the socket's handshake, by the WIB date, so the socket is reopened when the date changes.
_Avoid_: destination, stage (a target names a Stage's dashboard, not the Stage)

**Target state**:
What a target's ingest socket is doing: off (no token), connecting, connected, retrying, token rejected (`4403`) or reload extension (`4426`). The last two stop retrying until the target's settings change.
_Avoid_: status

**On-demand codes**:
The codes the trading-day objects ask the relay to keep subscribed on Ajaib's `PRICE`, `INDICATIVE` and `ORDER_BOOK_CUSTOM` streams: the union across both targets. Each code is subscribed once per socket; a change sends only the difference.
_Avoid_: watchlist codes

**Code list**:
Ajaib's stock code list, fetched once a WIB day from the Ajaib tab with the page's own headers and sent up raw, and again to each target's fresh socket after its token when it is that socket's day's. Stockbit's channel message lists every code on it, an earlier day's until the day's fetch answers.
_Avoid_: universe

**Streaming window**:
Where the relay's schedule clock is: closed (outside 08:40–16:35 WIB on trading days, every socket closed), auction (pre-opening and pre-closing, a dropped connection reconnects but none opens fresh) or open.
_Avoid_: market hours

**Ajaib account id**:
The number Ajaib's subscribe frames carry as `id`, read from the `sub` claim of an Ajaib access token: the Ajaib tab's own, once the page has made a REST call, else the PIN sign-in's. Until either is seen, frames go without it.
_Avoid_: user id (Stockbit's subscribe has its own `user_id`)

**PIN sign-in**:
The owner's 6-digit Ajaib PIN, entered on the options page and kept in `chrome.storage.session` only, which the Ajaib tab checks once with Ajaib's PIN validate call to get an access token. A refused PIN is never tried again; only a new entry is.
_Avoid_: login, PIN retry
