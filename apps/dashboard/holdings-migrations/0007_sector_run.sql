-- The last sector run's outcome, cron or Run now, which the Sectors card on
-- /admin/shareholding shows so a run that keeps or fails is seen. One row,
-- replaced by each run (src/server/sectors/sync.ts).
CREATE TABLE sector_run (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('Replaced', 'Kept', 'Failed')),
  -- The rows a Replaced run wrote; NULL otherwise.
  rows INTEGER,
  -- Why a run kept the table or failed; NULL for Replaced.
  message TEXT,
  -- An ISO instant: when the run read IDX.
  ran_at TEXT NOT NULL,
  CHECK ((outcome = 'Replaced') = (rows IS NOT NULL AND message IS NULL))
);
