-- An unfinished cutover import's progress (src/server/archive/run-import.ts),
-- in place of 0003's two tables, which this drops. An import is several
-- scans of a kind's R2 run records, each with a purpose of its own, and each
-- scan keeps its progress in a row that only it reads. 0003 kept one mark
-- for every purpose, so a record that one purpose passed over was lost to
-- another that needed it. What 0003's tables held is not carried over: an
-- import that was unfinished reads its records again and writes the same
-- rows. A kind's rows here go when `run_import` marks it imported. Decided
-- in ADR 0128.

-- A trigger's window scan: its runs of the past 30 days, read oldest first.
CREATE TABLE run_import_window (
  archive TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  -- The R2 key of the last record it read: it resumes after this key.
  after_key TEXT NOT NULL,
  PRIMARY KEY (archive, run_kind, trigger)
) WITHOUT ROWID;

-- A trigger's reader scan: its runs however old, read newest first, until
-- one holds a run that the trigger's reader past retention takes.
CREATE TABLE run_import_reader (
  archive TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  -- The R2 key of the last record it read: it resumes before this key.
  before_key TEXT NOT NULL,
  -- 1 once it has kept the run its reader takes, which ends the scan.
  found INTEGER NOT NULL CHECK (found IN (0, 1)),
  PRIMARY KEY (archive, run_kind, trigger)
) WITHOUT ROWID;

DROP TABLE run_import_passed;

DROP TABLE run_import_found;
