-- Parsed holdings from IDX's month-end "holdings by investor classification"
-- reports, keyed by the report's data date (YYYY-MM-DD). One set of rows per
-- date: the newest archived version replaces the older one in one batch
-- (src/server/holdings/month-replace.ts).

-- Shares one investor classification holds of a stock, by origin. Zeros are
-- skipped, so a missing row means 0. A month before Sep 2026 has `combined`
-- rows only; a later month has `local` and `foreign` rows and a `combined`
-- row per classification holding their sum.
-- Decision: WITHOUT ROWID and keyed on the full key, so an insert writes one
-- row and no index row. See apinrdw/kumora#355.
CREATE TABLE classification_holding (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  classification TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('local', 'foreign', 'combined')),
  shares INTEGER NOT NULL CHECK (shares > 0),
  PRIMARY KEY (data_date, stock_code, classification, origin)
) WITHOUT ROWID;

-- One row per stock in a month's report.
CREATE TABLE classification_stock_month (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- As the report prints it.
  issuer_name TEXT NOT NULL,
  total_scripless INTEGER NOT NULL,
  PRIMARY KEY (data_date, stock_code)
) WITHOUT ROWID;

-- The archived version a month's rows were parsed from, and by which parser
-- version: the archive run's reconcile parses a month again when either
-- changes.
CREATE TABLE classification_month (
  data_date TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  -- An ISO instant.
  parsed_at TEXT NOT NULL
);
