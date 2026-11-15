-- Parsed holdings from KSEI's monthly Kepemilikan Efek files
-- (BalanceposEfek<YYYYMMDD>.zip), keyed by the file's period end
-- (YYYY-MM-DD). One set of rows per period end: the newest archived version
-- replaces the older one in one batch (src/server/holdings/month-replace.ts).
-- Every EQUITY row of a file is kept, priced or not.

-- Scripless shares one KSEI investor type holds of a stock, by origin. Zeros
-- are skipped, so a missing row means 0.
-- Decision: WITHOUT ROWID and keyed on the full key, as
-- classification_holding. See apinrdw/kumora#355.
CREATE TABLE ksei_holding (
  period_end TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('local', 'foreign')),
  investor_type TEXT NOT NULL CHECK (
    investor_type IN ('ID', 'CP', 'MF', 'IB', 'IS', 'SC', 'PF', 'FD', 'OT')
  ),
  shares INTEGER NOT NULL CHECK (shares > 0),
  PRIMARY KEY (period_end, stock_code, origin, investor_type)
) WITHOUT ROWID;

-- One row per EQUITY row of a file.
CREATE TABLE ksei_stock_month (
  period_end TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- `Sec. Num`.
  listed_shares INTEGER NOT NULL,
  -- The month-end close in rupiah; 0 for an unpriced (suspended or delisted)
  -- stock.
  price INTEGER NOT NULL,
  -- The local and foreign Totals' sum.
  total_scripless INTEGER NOT NULL,
  PRIMARY KEY (period_end, stock_code)
) WITHOUT ROWID;

-- The archived version a period end's rows were parsed from, and by which
-- parser version: the KSEI parse run parses a month again when either
-- changes.
CREATE TABLE ksei_month (
  period_end TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  -- An ISO instant.
  parsed_at TEXT NOT NULL
);
