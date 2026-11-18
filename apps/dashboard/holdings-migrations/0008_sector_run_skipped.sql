-- sector_run again, now with the profiles a Replaced run skipped, so the
-- Sectors card names them. A forward migration because Previews had applied
-- 0007 (.claude/skills/post-implementation-review/workspaces/deploy.md); its
-- one row is the last run's and the next run rewrites it, so none is kept.
DROP TABLE sector_run;
CREATE TABLE sector_run (
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
