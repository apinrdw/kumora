-- Every code on IDX's Special Monitoring Board (Papan Pemantauan Khusus):
-- the codes whose special notation includes X. The daily board cron
-- (src/server/special-board/sync.ts) replaces every row in one batch, or
-- keeps them all when a run fails its sanity gate. Spec apinrdw/kumora#517,
-- "Ticks, limits and excluded codes".
CREATE TABLE special_board (
  code TEXT NOT NULL PRIMARY KEY,
  -- Every notation IDX lists for the code, as it lists them: "E,D,S,X".
  notation TEXT NOT NULL,
  -- An ISO instant: when the run that wrote the row read IDX.
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
