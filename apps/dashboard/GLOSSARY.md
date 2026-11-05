# Dashboard

The market terminal for the Indonesian stock exchange: Whale Radar and Whale Radar Live. The candidates on Whale Radar are demo data.

## Language

### Instruments

**Symbol**:
The four-letter IDX stock code that identifies an instrument, such as BBCA. An **Ownership file** publishes Symbols outside that shape too, such as EDJSA, and they are stored as published.
_Avoid_: Ticker (for the code), code, kode saham

**Sector**:
The industry group an instrument belongs to, drawn from a fixed list.

**Liquidity**:
How readily an instrument trades, as a two-level grade: high or medium.

### Prices and flow

**Quote**:
The full trading state of an instrument for the current session: last, previous close, open, high, low, average, volume, value, and frequency.

**Quote summary**:
The compact view of a quote shown in lists: last price, change, volume, VWAP, and the latest end-of-day net flow.
_Avoid_: Quote (for the compact form)

**Candle**:
The open, high, low, close, and volume of one period: a **session candle** for a whole session, a **minute candle** for one minute of a symbol's regular-board trades, or a longer intraday period built from minute candles.
_Avoid_: Bar

**Candle period**:
How long one candle lasts. It is not a **Timeframe**, which is how far back a view looks.

**Net flow**:
Net broker buying minus selling for an instrument over a period, in rupiah, from end-of-day data. Absent when the feed has no coverage.
_Avoid_: Broker flow (for the figure), flow

**Net foreign**:
Net foreign buying minus selling, market-wide or per instrument.

**Timeframe**:
The lookback window a view or figure covers. Each screen offers its own subset of the shared list.
_Avoid_: Period, range, window

### Trades and the tape

**Trade**, **Relay**, **Source**, **Ingest**, **Active ingest**, **Own session**:
Shared with the relay extension, so defined in `GLOSSARY-MAP.md`.

**Tape**:
The time-ordered trades of one symbol, or of the whole market, for the current session.
_Avoid_: Time and sales, running trades

**Trade identity**:
What makes two reports the same trade: the trading day, the symbol, and the exchange's trade number.

**Regular board**:
The exchange's continuous auction board, RG. Only its trades build candles, the volume profile, aggressor orders, walls, and the last price.

**Off-board trade**:
A trade on any board but the **Regular board**: today the cash board (TN) and the negotiated board (NG). It stays on the tape and moves nothing the regular board builds.
_Avoid_: Crossing, block trade, negotiated trade (for the general term)

**Trade feed**:
The feed that carries trades during the session, live from the relay.

**Upstream session**:
A logged-in Stockbit connection that trades originate from, whether the relay holds it or the operator's browser does.

**Extension**:
The browser extension in the operator's logged-in Stockbit tab that forwards the tab's trades to the relay.

**Backfill**:
The tape the relay sends a dashboard session when it subscribes to a symbol, before live trades.
_Avoid_: Snapshot, replay, history

**Volume profile**:
The lots of a symbol's regular-board trades at each price over the session so far, split by the taker's side into buy, sell, and unspecified. It covers the whole session, whatever part of it a chart shows.
_Avoid_: Volume by price, market profile

**Source gap**:
A span when the relay had no source, so trades in it went unseen. A minute with no trades while a source was active is quiet, not a gap.
_Avoid_: Outage, no-data band

**Relay status**:
What the relay reports about itself: the active source, whether each source is up and since when, and the time of the last trade.
_Avoid_: Health, heartbeat (for the report)

### Sweeps and walls

**Aggressor order**:
The trades one taker order produced on a symbol, read back from the tape as the run of consecutive trade numbers on one side in one instant. An order larger than the exchange allows is sent as several at once and reads as one.
_Avoid_: Group, cluster, burst

**Sweep**:
An aggressor order on the regular board whose lots reach the symbol's whale threshold: a sweep buy or a sweep sell by the taker's side. It is announced the moment it crosses and grows until the order ends.
_Avoid_: Whale trade, big trade, block, large print

**Whale threshold**:
The lot size an aggressor order must reach to be a sweep on a symbol: the 99th percentile of the symbol's aggressor-order lots this session on the regular board, resting on the previous session until today has enough.
_Avoid_: Cutoff, limit, floor

**Warming up**:
The state of a whale threshold that still rests mostly on the previous session's distribution rather than today's. Every sweep announced in that state says so.

**Wall**:
A maker order, or split orders placed together, that keeps absorbing trades until the lots matched against it reach the symbol's whale threshold: a bid wall or an offer wall by its side. A wall is seen only through the trades that hit it, never from the order book, so its size is what has been eaten so far.
_Avoid_: Iceberg, big order, resting order (for one that has crossed the threshold)

**Wall coverage**:
The symbols whose walls the relay can see: the symbols open on a page plus the watched list the relay last received. A symbol outside it has unknown walls, not none.
_Avoid_: Liveprice list, wall list

**Whale event**:
One row of the whale radar live page's feed: a sweep or a wall. Its type is Sweep Buy, Sweep Sell, Bid Wall, or Offer Wall, and there are no others.
_Avoid_: Pattern (a signal's direction), pola

### Ownership

**Ownership file**:
One version of a file IDX published for one dataset and as-of date. A republished file with different content is a new version; the earlier one is kept.
_Avoid_: Upload, report

**Holding line**:
One holder row exactly as published in a 5% or 1% ownership file. It is identified by its file and position, because one holder can have several lines, some identical.
_Avoid_: Holding (for the row), position (for the row)

**Holder position**:
The sum of a holder's holding lines for one symbol and as-of date. Names that differ only by punctuation or case are the same holder; no other names are merged.
_Avoid_: Stake

**Ownership breakdown**:
The shares in each category for one symbol and month, by investor type or by investor classification. Older files have no local or foreign side.

**Investor type**:
The category scheme of the per-type dataset, and the codes older 1% files carry. It does not map onto investor classification.

**Investor classification**:
The finer category scheme of the classification dataset and of newer 1% files. It does not map onto investor type.
_Avoid_: Investor type (for this scheme)

**Run report**:
What the operator's routine reports after each hourly run: when it ran and what it found. It tells a routine that never ran apart from a file not yet published.
_Avoid_: Heartbeat

### Signals

**Signal**:
The model's pattern classification for an instrument: accumulation, distribution, mixed, neutral, or insufficient.
_Avoid_: Verdict, call, recommendation

**Pattern**:
A signal that names a direction: accumulation, distribution, or mixed. Used where neutral and insufficient cannot occur.

**Confidence**:
The model's certainty in its classification, from 0 to 100. Never a probability of profit.
_Avoid_: Score, probability

**Evidence**:
One labelled observation supporting a signal, with its source and as-of time.

**Counter-evidence**:
One observation arguing against the signal.

**Hypothesis**:
The model's one-sentence reading of what the signal means for the instrument.

**Candidate**:
An instrument the whale radar surfaces, with its signal, confidence, evidence, and recent history.

### Freshness

**Feed**:
A source the terminal draws figures from: the price feed, the trade feed, the broker end-of-day feed, the model, or one of the four ownership feeds (5%, 1%, investor type, investor classification).

**Provenance**:
Which feed a figure came from, its as-of, for the trade feed the source, and for model output the version that computed it.

**As-of**:
The instant a figure was last true at its source.

**Freshness**:
How current a figure is relative to its feed: live, delayed, end-of-day, or stale. Live means arriving now from the active source; it does not mean the feed is licensed.

**Feed dependency**:
Which kind of feed a figure or rule relies on: end-of-day, delayed, or live.

**Feed notice**:
The state of a feed whose panel shows a notice instead of a chart: its freshness, as-of, a title, and a description.

### Pages and read models

**Read model**:
Everything one page needs, with the provenance of its feeds, served whole by that page's service. Pages render a read model; they never read fixtures.
_Avoid_: View model, page data

**Shell**:
The frame around every page: sidebar, header, and the net foreign tape. It reads the market overview once, at the root of the app.

**Market overview**:
The market-wide figures the shell shows on every page: IHSG last and change, net foreign flow, and the net foreign tape (net foreign per symbol), with their as-of.
