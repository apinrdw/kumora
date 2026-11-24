-- The report index: one row per archived report version, that is per record
-- under reports/ in the KSEI archive's or the shareholding archive's bucket.
-- R2 stays the source of truth; each row is derived from its record's key
-- and the sizes of the record and its file, so the index can be rebuilt from
-- a listing of reports/ (src/server/archive/report-index.ts). Decided in
-- apinrdw/kumora#659: the index is a copy of R2 that each archive run heals.
CREATE TABLE archived_report (
  archive TEXT NOT NULL CHECK (archive IN ('ksei', 'shareholding')),
  -- reports/<kind>/<date>/<sha256>.<fetched-at>.<digest>.json, the row's
  -- identity: inserting it again is a no-op.
  record_key TEXT NOT NULL,
  -- The KSEI report kind or the Report kind.
  kind TEXT NOT NULL,
  -- YYYY-MM-DD: the KSEI report's period end, the shareholding report's
  -- data date.
  report_date TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  -- An ISO instant.
  fetched_at TEXT NOT NULL,
  -- The stored file the record is one version of. Several records can share
  -- one file: the same bytes seen under another name or ETag.
  file_key TEXT NOT NULL,
  file_bytes INTEGER NOT NULL,
  record_bytes INTEGER NOT NULL,
  PRIMARY KEY (archive, record_key)
) WITHOUT ROWID;
