-- Parsed ≥1% holders from IDX's month-end "holders above 1%" reports, keyed
-- by the report's data date (YYYY-MM-DD). One set of rows per date: the
-- newest archived version replaces the older one in one batch
-- (src/server/holdings/month-replace.ts). Schema from apinrdw/kumora#472.

-- One row per published row, kept as published: a holder IDX prints on
-- several rows keeps them all, and Apr 2026's RALS lists one exact name
-- twice.
-- Decision: keyed by the row's position among its stock's rows, not by the
-- investor's name: (stock, exact name) repeats once in Apr 2026, and (stock,
-- holder key) 2–29 times a month. See apinrdw/kumora#472.
CREATE TABLE above_1_holding (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- 1 for the stock's first row in the file, then 2, ….
  seq INTEGER NOT NULL,
  issuer_name TEXT NOT NULL,
  -- INVESTOR_NAME as published, its outer spaces trimmed.
  investor_name TEXT NOT NULL,
  -- The name matched month to month (src/server/holdings/above-1.ts).
  holder_key TEXT NOT NULL,
  -- An investor classification's slug; null in Feb–Mar 2026, which publish
  -- a KSEI type instead, or when blank.
  classification TEXT,
  -- As published in Feb–Mar 2026, or the classification's KSEI type; null
  -- when blank.
  investor_type TEXT CHECK (
    investor_type IN ('ID', 'CP', 'MF', 'IB', 'IS', 'SC', 'PF', 'FD', 'OT')
  ),
  -- Null for a special scrip account, which publishes none.
  origin TEXT CHECK (origin IN ('local', 'foreign')),
  nationality TEXT,
  domicile TEXT,
  -- CONTROLLER_OR_AFFILIATE, published from Oct 2026; null when blank or
  -- before.
  controller TEXT CHECK (controller IN ('controller', 'affiliate')),
  scripless INTEGER NOT NULL CHECK (scripless >= 0),
  scrip INTEGER NOT NULL CHECK (scrip >= 0),
  -- TOTAL_HOLDING_SHARES as published, never checked against scripless +
  -- scrip.
  total INTEGER NOT NULL CHECK (total >= 0),
  -- PERCENTAGE as published, rounded to 2 decimals, × 100.
  percentage_hundredths INTEGER NOT NULL CHECK (percentage_hundredths >= 0),
  PRIMARY KEY (data_date, stock_code, seq)
) WITHOUT ROWID;

-- The archived version a month's rows were parsed from, and by which parser
-- version: the above-1% parse run parses a month again when either changes.
CREATE TABLE above_1_month (
  data_date TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  -- An ISO instant.
  parsed_at TEXT NOT NULL
);

-- The stock page reads one stock across months.
CREATE INDEX above_1_holding_by_stock
ON above_1_holding (stock_code, data_date, holder_key);

CREATE INDEX above_1_holding_by_holder
ON above_1_holding (holder_key, data_date);
