-- Parsed holdings from IDX's month-end "holdings by investor type" reports,
-- keyed by the report's data date (YYYY-MM-DD). One set of rows per date:
-- the newest archived version replaces the older one in one batch
-- (src/server/holdings/month-replace.ts). Every stock of a report is kept,
-- priced or not. Schema from apinrdw/kumora#396.

-- Scripless shares one KSEI investor type holds of a stock, by origin, split
-- into the report's <5% and >=5% bands. A row with both bands 0 is skipped,
-- so a missing row means 0 in both. Nov–Dec 2025 have `combined` rows only;
-- a later month has `local` (the report's DOMESTIC) and `foreign` rows and a
-- `combined` row per type holding their sum.
-- Decision: two band columns, not a band key: the stock page always reads
-- both bands together, about 15k rows a month instead of 25k. WITHOUT ROWID
-- and keyed on the full key, as classification_holding. See
-- apinrdw/kumora#396.
CREATE TABLE investor_type_holding (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('local', 'foreign', 'combined')),
  investor_type TEXT NOT NULL CHECK (
    investor_type IN ('ID', 'CP', 'MF', 'IB', 'IS', 'SC', 'PF', 'FD', 'OT')
  ),
  -- The report's <5% column.
  under_5 INTEGER NOT NULL CHECK (under_5 >= 0),
  -- The report's >=5% column.
  at_least_5 INTEGER NOT NULL CHECK (at_least_5 >= 0),
  CHECK (under_5 + at_least_5 > 0),
  PRIMARY KEY (data_date, stock_code, origin, investor_type)
) WITHOUT ROWID;

-- One row per stock in a month's report.
CREATE TABLE investor_type_stock_month (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- JUMLAH_SAHAM_BEREDAR / NUMBER_OF_SHARES: what the 5% is measured
  -- against.
  shares_outstanding INTEGER NOT NULL,
  total_scripless INTEGER NOT NULL,
  PRIMARY KEY (data_date, stock_code)
) WITHOUT ROWID;

-- The archived version a month's rows were parsed from, by which parser
-- version, and whether its header splits local from foreign (1 from Jan
-- 2026): the investor-type parse run parses a month again when either
-- version changes.
CREATE TABLE investor_type_month (
  data_date TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  -- An ISO instant.
  parsed_at TEXT NOT NULL,
  split INTEGER NOT NULL CHECK (split IN (0, 1))
);

-- The stock page reads one stock across months.
CREATE INDEX investor_type_holding_by_stock
ON investor_type_holding (stock_code, data_date);

CREATE INDEX investor_type_stock_month_by_stock
ON investor_type_stock_month (stock_code, data_date);
