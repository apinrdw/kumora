-- The disclosure archive's index and runs (spec apinrdw/kumora#715). Its
-- disclosures don't fit the report index: they have no report kind, and a
-- stored version or attachment never gets another version. Each disclosure
-- is keyed by IDX's Id2 without its language suffix, and nothing stored is
-- fetched again (apps/dashboard/docs/adr/0136 and 0137).

-- `run` again, with 'disclosure' among its archives: SQLite changes a CHECK
-- only by building the table anew. Its rows, indexes and the claim on each
-- kind's run carry over as they were.
CREATE TABLE run_next (
  archive TEXT NOT NULL CHECK (archive IN ('ksei', 'shareholding', 'disclosure')),
  run_kind TEXT NOT NULL,
  id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  latest INTEGER CHECK (latest = 1),
  record TEXT NOT NULL,
  PRIMARY KEY (archive, run_kind, id)
) WITHOUT ROWID;

INSERT INTO run_next (archive, run_kind, id, trigger, started_at, outcome, latest, record)
SELECT archive, run_kind, id, trigger, started_at, outcome, latest, record FROM run;

DROP TABLE run;

ALTER TABLE run_next RENAME TO run;

CREATE UNIQUE INDEX run_claim ON run (archive, run_kind) WHERE latest = 1;

CREATE INDEX run_started ON run (archive, run_kind, started_at);

CREATE INDEX run_trigger_started ON run (archive, run_kind, trigger, started_at);

-- One row per stored disclosure version: its listing is in the bucket at
-- `object_key`, as IDX listed it the first time.
CREATE TABLE disclosure_version (
  disclosure_key TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('id', 'en')),
  -- YYYY-MM-DD in WIB, the disclosure day it was published on.
  day TEXT NOT NULL,
  object_key TEXT NOT NULL,
  -- An ISO instant.
  stored_at TEXT NOT NULL,
  PRIMARY KEY (disclosure_key, language)
) WITHOUT ROWID;

CREATE INDEX disclosure_version_day ON disclosure_version (day, language);

-- One row per attachment a stored version lists, once per disclosure and
-- path however many of its versions list it. `stored_at` is null until a
-- run has stored the file at `object_key`.
CREATE TABLE disclosure_attachment (
  disclosure_key TEXT NOT NULL,
  -- Its path on IDX's site, as /StaticData/…/x.pdf; www.idx.id serves it.
  path TEXT NOT NULL,
  day TEXT NOT NULL,
  object_key TEXT NOT NULL,
  -- An ISO instant, and the file's size, once stored.
  stored_at TEXT,
  bytes INTEGER,
  -- When a run first failed to download it, and its last failure's
  -- message, while it isn't stored.
  first_failed_at TEXT,
  last_error TEXT,
  PRIMARY KEY (disclosure_key, path)
) WITHOUT ROWID;

CREATE INDEX disclosure_attachment_waiting ON disclosure_attachment (day)
WHERE stored_at IS NULL;

-- When a run last listed each disclosure day in both languages.
CREATE TABLE disclosure_day (
  day TEXT NOT NULL PRIMARY KEY,
  -- An ISO instant.
  listed_at TEXT NOT NULL
) WITHOUT ROWID;
