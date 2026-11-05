-- The IDX share ownership store. See docs/specs/idx-share-ownership.md.
-- The holding line and breakdown tables' columns match FORMATS in src/ownership/csv.ts, where each
-- NOT NULL text column is `requiredText`. Change the two together.
-- Never delete from this table: versions tied on first_received_at resolve by rowid, as insertion order.
CREATE TABLE ownership_files (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  csv_sha256 TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  first_received_at TEXT NOT NULL,
  -- The values of FileStatus in src/ownership/store.ts. Change the two together.
  status TEXT NOT NULL CHECK (status IN ('loading', 'loaded', 'failed')),
  error TEXT,
  -- Each Workflow instance of a file has its own id: <file id>-<attempt>.
  attempt INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_sha256, csv_sha256)
);
CREATE INDEX ownership_files_in_force ON ownership_files (dataset, as_of, first_received_at);

-- lima-persen. Numeric columns are nullable; see the endpoint's rule on empty cells.
CREATE TABLE holding_lines_5 (
  file_id TEXT NOT NULL REFERENCES ownership_files (id),
  row_no INTEGER NOT NULL,
  as_of TEXT NOT NULL, previous_date TEXT, holder_no INTEGER, symbol TEXT NOT NULL,
  issuer_name TEXT, account_holder TEXT, holder_name TEXT, holder_key TEXT, account_name TEXT,
  nationality TEXT, domicile TEXT, status TEXT,
  previous_shares INTEGER, previous_combined_shares INTEGER, previous_percent REAL,
  shares INTEGER, combined_shares INTEGER, percent REAL, change INTEGER,
  PRIMARY KEY (file_id, row_no)
) WITHOUT ROWID;
CREATE INDEX holding_lines_5_symbol ON holding_lines_5 (symbol, as_of);

-- satu-persen.
CREATE TABLE holding_lines_1 (
  file_id TEXT NOT NULL REFERENCES ownership_files (id),
  row_no INTEGER NOT NULL,
  as_of TEXT NOT NULL, symbol TEXT NOT NULL, issuer_name TEXT,
  investor_name TEXT, holder_key TEXT, classification TEXT, investor_type_code TEXT,
  local_foreign TEXT, nationality TEXT, domicile TEXT,
  scripless INTEGER, scrip INTEGER, total INTEGER, percent REAL,
  PRIMARY KEY (file_id, row_no)
) WITHOUT ROWID;
CREATE INDEX holding_lines_1_symbol ON holding_lines_1 (symbol, as_of);

-- tipe.
CREATE TABLE breakdown_by_type (
  file_id TEXT NOT NULL REFERENCES ownership_files (id),
  row_no INTEGER NOT NULL,
  as_of TEXT NOT NULL, symbol TEXT NOT NULL, number_of_shares INTEGER,
  side TEXT, category TEXT NOT NULL, band TEXT NOT NULL, shares INTEGER, total_scripless INTEGER,
  PRIMARY KEY (file_id, row_no)
) WITHOUT ROWID;
CREATE INDEX breakdown_by_type_symbol ON breakdown_by_type (symbol, as_of);

-- klasifikasi.
CREATE TABLE breakdown_by_classification (
  file_id TEXT NOT NULL REFERENCES ownership_files (id),
  row_no INTEGER NOT NULL,
  as_of TEXT NOT NULL, symbol TEXT NOT NULL, issuer_name TEXT,
  side TEXT, category TEXT NOT NULL, shares INTEGER, total_scripless INTEGER,
  PRIMARY KEY (file_id, row_no)
) WITHOUT ROWID;
CREATE INDEX breakdown_by_classification_symbol ON breakdown_by_classification (symbol, as_of);

CREATE TABLE row_flags (
  file_id TEXT NOT NULL REFERENCES ownership_files (id),
  row_no INTEGER NOT NULL,
  rule TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (file_id, row_no, rule)
) WITHOUT ROWID;

CREATE TABLE run_reports (
  ran_at TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  files_sent INTEGER NOT NULL
) WITHOUT ROWID;
