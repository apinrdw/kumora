# Extension

The relay: an unpacked Chrome MV3 extension that reads the owner's signed-in broker tabs and sends their raw frames to the dashboard's trading-day Durable Object. Words from `packages/relay/GLOSSARY.md` and `apps/dashboard/GLOSSARY.md`: **relay**, **feed**, **ingest envelope**, **ingest token**, **streaming hours**.

## Language

**Broker tab**:
A tab of a broker site (Ajaib today) the owner keeps open and signed in. Its content script opens the relay's own sockets from the tab's origin; with no broker tab open, that feed is unavailable.
_Avoid_: page socket, source tab

**Connection**:
One of a broker site's two relay sockets, A or B. B opens on the tick after A's first frame, and at most one connection opens per tick.
_Avoid_: stream, channel

**Tick**:
The service worker's 10 s heartbeat. A connection quiet since the last tick sends its ping; one still unanswered at the next tick reopens.
_Avoid_: interval, poll

**Target**:
A dashboard the relay sends envelopes to over its own ingest socket: always Production, plus at most one extra target (Staging, a Preview or a Dev stage) set on the options page.
_Avoid_: destination, stage (a target names a Stage's dashboard, not the Stage)

**Target state**:
What a target's ingest socket is doing: off (no token), connecting, connected, retrying, token rejected (`4403`) or reload extension (`4426`). The last two stop retrying until the target's settings change.
_Avoid_: status
