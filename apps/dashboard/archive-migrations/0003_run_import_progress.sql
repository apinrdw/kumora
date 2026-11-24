-- An unfinished cutover import's progress (src/server/archive/run-import.ts).
-- One Worker invocation imports at most a set number of a kind's R2 run
-- records, under its limits on calls to D1 and R2, so the next one resumes
-- where it stopped: a record whose run has a row in `run`, or one here, is
-- never read again. A kind's rows here go when `run_import` marks it
-- imported. Decided in ADR 0128.

-- The R2 run records the import read and kept no row of: one that no longer
-- decodes or has gone, one that started before the past 30 days, or one a
-- reader past retention passed over.
CREATE TABLE run_import_passed (
  archive TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  -- The run id its R2 key names.
  id TEXT NOT NULL,
  PRIMARY KEY (archive, run_kind, id)
) WITHOUT ROWID;

-- The triggers whose reader past retention has had its newest run imported.
CREATE TABLE run_import_found (
  archive TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  PRIMARY KEY (archive, run_kind, trigger)
) WITHOUT ROWID;
