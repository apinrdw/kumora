-- The last sector run's outcome, cron or Run now, which the Sectors card on
-- /admin/shareholding shows so a run that keeps, skips or fails is seen.
-- One row, replaced by each run (src/server/sectors/sync.ts).
CREATE TABLE sector_last_run (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  outcome TEXT NOT NULL,
  -- A Replaced run: the rows it wrote, and a JSON array of each profile it
  -- left out, as "CODE (why)".
  rows INTEGER,
  skipped TEXT,
  -- A Kept or Failed run: why.
  message TEXT,
  -- An ISO instant: when the run read IDX.
  ran_at TEXT NOT NULL,
  CHECK (
    (outcome = 'Replaced' AND rows IS NOT NULL AND skipped IS NOT NULL AND message IS NULL)
    OR (outcome IN ('Kept', 'Failed') AND rows IS NULL AND skipped IS NULL AND message IS NOT NULL)
  )
);
