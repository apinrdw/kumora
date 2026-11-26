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
The service worker's 10 s heartbeat. A connection quiet since the last tick sends its ping; one still unanswered at the next tick reopens. In e2e a changed test clock offset also ticks at once.
_Avoid_: interval, poll

**Target**:
A dashboard the relay sends envelopes to over its own ingest socket: always Production, plus at most one extra target (Staging, a Preview or a Dev stage) set on the options page. A target is held by its dashboard's Stage URL (`packages/deploy/GLOSSARY.md`), base path included: a target URL with no path, saved by an older relay or typed on the options page, means that dashboard's base path, and one with a path is kept as is. The dashboard picks the trading-day object at the socket's handshake, by the WIB date, so the socket is reopened when the date changes.
_Avoid_: destination, stage (a target names a Stage's dashboard, not the Stage)

**Target state**:
What a target's ingest socket is doing: off (no token), connecting, connected, retrying, token rejected (`4403`) or reload extension (`4426`). The last two stop retrying until the target's settings change. A broker codes POST or status GET refused with a 401 or 426 puts the target in the same two states. On the extra target, a broker codes request that fails for any other reason shows retrying.
_Avoid_: status

**On-demand codes**:
The codes the trading-day objects ask the relay to keep subscribed on Ajaib's `PRICE`, `INDICATIVE` and `ORDER_BOOK_CUSTOM` streams: the union across both targets. Each code is subscribed once per socket; a change sends only the difference. A code a target newly asks for that a socket already holds is sent UNSUBSCRIBE then SUBSCRIBE, so that Ajaib sends that target its whole book. Spec #138 ("The extension") documents the whole book on subscribing: `ORDER_BOOK_CUSTOM` sends its own `is_initial` snapshot, then deltas. That it sends one again after the pair is inferred from Ajaib's own page sending the pair on a code change, not yet observed.
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
The owner's 6-digit Ajaib PIN, entered on the options page and kept in `chrome.storage.session` only, until Chrome closes. The Ajaib tab checks each entry once with Ajaib's PIN validate call to get an access token; the sign-in's state, not the PIN's removal, keeps it to once. The extension types the kept PIN into Ajaib's lock screen, once per lock, and only after its sign-in succeeded. A PIN whose sign-in ended any other way, or that the lock screen was not seen to accept, is wiped and never tried again; only a new entry is.
_Avoid_: login, PIN retry

**Ajaib locked**:
Ajaib's idle PIN lock showing on the relayed tab with no way for the extension to unlock it: no PIN kept, the kept one refused, or no lock screen boxes found. The extension keeps the lock away with a synthetic `mousemove` every 10 minutes, and records this cause for the options page and badge when it shows anyway.
_Avoid_: PIN lock (the screen itself), signed out
