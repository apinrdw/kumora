-- Every run of either archive: its archive runs and its parse runs, one row
-- per run, with the columns its reads filter and sort on and the whole run
-- record as JSON, decoded with today's run schemas on read
-- (src/server/archive/runs.ts). ArchiveDb is the source of truth for runs;
-- the R2 run records written before it are imported once per run kind.
-- Decided in apinrdw/kumora#659.
CREATE TABLE run (
  archive TEXT NOT NULL CHECK (archive IN ('ksei', 'shareholding')),
  -- Which of the archive's runs: 'archive', or a parse run's kind.
  run_kind TEXT NOT NULL,
  -- Also its Workflow instance's id.
  id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  -- Epoch ms.
  started_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  -- 1 on the run the kind's last start claimed, NULL on every other: the one
  -- claim on starting a run of the kind.
  latest INTEGER CHECK (latest = 1),
  -- The run record, as JSON.
  record TEXT NOT NULL,
  PRIMARY KEY (archive, run_kind, id)
) WITHOUT ROWID;

-- One latest row per archive and run kind: inserting a run's row with it is
-- the claim on starting the run (ADR 0126).
CREATE UNIQUE INDEX run_claim ON run (archive, run_kind) WHERE latest = 1;

CREATE INDEX run_started ON run (archive, run_kind, started_at);

CREATE INDEX run_trigger_started ON run (archive, run_kind, trigger, started_at);

-- The run kinds whose R2 run records have been imported, once each.
CREATE TABLE run_import (
  archive TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  PRIMARY KEY (archive, run_kind)
) WITHOUT ROWID;
