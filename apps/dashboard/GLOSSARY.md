# Dashboard

The market terminal for the Indonesian stock exchange. Today it is only its shell, with no pages.

## Language

### Prices and flow

**Candle**:
The open, high, low, close, and volume of one period.
_Avoid_: Bar

**Stock code**:
The IDX ticker that names one listed instrument, such as `BBCA`.
_Avoid_: Symbol, ticker

**Watchlist**:
The stock codes a user chooses to keep an eye on, with each one's last price, change, value, volume and frequency for the day. Each browser keeps its own.
_Avoid_: Favourites, portfolio

**Big trade**:
A running trade worth at least Rp1 miliar.
_Avoid_: Whale trade

**Frequency**:
How many running trades a stock code has had in the day so far.
_Avoid_: Trade count, ticks

**Running trade**:
One executed trade on the exchange's tape: its time, stock code, price and lots, and the buyer and seller brokers when the feed carries them. The running trades of every stock code together make the tape.
_Avoid_: Done trade, tick

**Trade number**:
The exchange's number for a running trade: one sequence across the whole market, restarting each trading day. Every feed that reports the same trade gives it the same trade number.
_Avoid_: Trade ID, sequence

**Net flow**:
Net broker buying minus selling for an instrument over a period, in rupiah, from end-of-day data. Absent when the feed has no coverage.
_Avoid_: Broker flow (for the figure), flow

### Freshness

**Feed**:
A source the terminal draws figures from, such as a price feed or a broker end-of-day feed.

**Relay**:
The browser extension's path that captures a broker site's live data from the owner's signed-in session and forwards it to the terminal, which keeps each trading day and serves it to signed-in viewers. Each broker site it relays from is its own feed.

**Provenance**:
Which feed a figure came from and its as-of.

**As-of**:
The instant a figure was last true at its source.

**Freshness**:
How current a figure is relative to its feed: live, delayed, end-of-day, stale, unavailable, or demo. Live means arriving now; it does not mean the feed is licensed.

### Shell

**Shell**:
The frame around every page: sidebar, header, and mobile bottom bar. It reads no market data.
