-- Broker totals: each complete day's per-broker totals and daily candles,
-- built by its trading-day object (src/server/market-live/broker-totals.ts)
-- and read by range for the stock page (src/server/broker-totals/db.ts).
-- Schema from apinrdw/kumora#419.

-- One broker's buys and sells of one stock on one day, by investor type
-- (`D` domestic, `F` foreign). Per day, never running sums. Value is
-- price × lots × 100.
-- Decision: keyed on code first, so a code's range is one key-range read;
-- the day index serves the build's delete of a day. See apinrdw/kumora#419.
CREATE TABLE totals (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  broker TEXT NOT NULL,
  investor_type TEXT NOT NULL CHECK (investor_type IN ('D', 'F')),
  buy_lots REAL NOT NULL,
  buy_value INTEGER NOT NULL,
  sell_lots REAL NOT NULL,
  sell_value INTEGER NOT NULL,
  PRIMARY KEY (code, day, broker, investor_type)
) WITHOUT ROWID;

CREATE INDEX totals_by_day ON totals (day);

-- One stock's regular-board day: open, high, low and close in trade number
-- order, volume in lots and value, and the trades counted (walk-filled
-- ones too).
CREATE TABLE candles (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  value INTEGER NOT NULL,
  trades INTEGER NOT NULL,
  PRIMARY KEY (code, day)
) WITHOUT ROWID;

CREATE INDEX candles_by_day ON candles (day);

-- A day whose totals and candles are whole, written last by each build: a
-- day without a row reads as a gap, whatever rows it holds.
CREATE TABLE built_days (
  day TEXT PRIMARY KEY,
  build_version INTEGER NOT NULL,
  built_at TEXT NOT NULL
) WITHOUT ROWID;
