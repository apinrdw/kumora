# Dashboard

The market terminal for the Indonesian stock exchange. Today it is only its shell, with no pages.

## Language

### Prices and flow

**Candle**:
The open, high, low, close, and volume of one period.
_Avoid_: Bar

**Net flow**:
Net broker buying minus selling for an instrument over a period, in rupiah, from end-of-day data. Absent when the feed has no coverage.
_Avoid_: Broker flow (for the figure), flow

### Freshness

**Feed**:
A source the terminal draws figures from, such as a price feed or a broker end-of-day feed.

**Provenance**:
Which feed a figure came from and its as-of.

**As-of**:
The instant a figure was last true at its source.

**Freshness**:
How current a figure is relative to its feed: live, delayed, end-of-day, stale, unavailable, or demo. Live means arriving now; it does not mean the feed is licensed.

### Shell

**Shell**:
The frame around every page: sidebar, header, and mobile bottom bar. It reads no market data.
