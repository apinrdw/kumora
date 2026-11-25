-- Parsed above-5% holders from IDX's daily "holders above 5%" reports, keyed
-- by the report's data date (YYYY-MM-DD), one trading day per report. One
-- set of rows per date: the newest archived version replaces the older one
-- in one batch (src/server/holdings/month-replace.ts). Only the report
-- date's columns are kept; the previous trading day's are checked for shape
-- and dropped. Spec apinrdw/kumora#673, "Storage"; the report's facts are in
-- apinrdw/kumora#670.

-- One row per published block (one investor, by IDX's SID), kept as
-- published: before 20 Nov 2026 IDX repeats an investor's block once per
-- name variant, and each repeat is a row of its own (collapsed on read,
-- apps/dashboard/docs/adr/0131-above-5-repeat-blocks-are-stored-as-published.md).
-- Keyed by the block's `No`, which runs 1..N across the whole report: (stock,
-- name) is not unique (CPGT lists two investors under one name).
CREATE TABLE above_5_holder (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- The report's `No`.
  no INTEGER NOT NULL,
  issuer_name TEXT NOT NULL,
  -- `Nama Pemegang Saham` as published, its outer spaces trimmed.
  holder_name TEXT NOT NULL,
  -- The name matched day to day (src/server/holdings/holder-key.ts), the
  -- same key the above-1% report's holders carry.
  holder_key TEXT NOT NULL,
  -- `Saham Gabungan Per Investor`: the sum of its accounts' shares.
  scripless INTEGER NOT NULL CHECK (scripless >= 0),
  -- `Persentase Kepemilikan Per Investor (%)` × 100, at least 500.
  percentage_hundredths INTEGER NOT NULL CHECK (percentage_hundredths >= 500),
  PRIMARY KEY (data_date, stock_code, no)
) WITHOUT ROWID;

-- One row per account of a block, in the block's row order.
CREATE TABLE above_5_account (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  no INTEGER NOT NULL,
  -- 1 for the block's first row, then 2, ….
  ordinal INTEGER NOT NULL,
  -- `Nama Pemegang Rekening Efek`: the broker or bank holding the account.
  custodian TEXT NOT NULL,
  -- `Nama Rekening Efek`.
  account_name TEXT NOT NULL,
  -- `Status (Lokal/Asing)`: L or A.
  origin TEXT NOT NULL CHECK (origin IN ('local', 'foreign')),
  -- `Kebangsaan`, published on about a quarter of the accounts.
  nationality TEXT,
  -- `Domisili`.
  domicile TEXT,
  -- `Jumlah Saham` of the report date; 0 for an account the report lists
  -- with `-`, emptied that day.
  scripless INTEGER NOT NULL CHECK (scripless >= 0),
  PRIMARY KEY (data_date, stock_code, no, ordinal)
) WITHOUT ROWID;

-- The archived version a day's rows were parsed from, and by which parser
-- version: the above-5% parse run parses a day again when either changes.
CREATE TABLE above_5_day (
  data_date TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  -- An ISO instant.
  parsed_at TEXT NOT NULL
);

-- The stock page reads one stock across days.
CREATE INDEX above_5_holder_by_stock
ON above_5_holder (stock_code, data_date);

CREATE INDEX above_5_account_by_stock
ON above_5_account (stock_code, data_date);
