-- Every listed stock's IDX-IC classification, from IDX's company profiles.
-- The daily sector cron (src/server/sectors/sync.ts) replaces every row in
-- one batch, or keeps them all when a run fails its sanity gates. Schema
-- from apinrdw/kumora#427, "Sectors".
CREATE TABLE stock_sector (
  code TEXT NOT NULL PRIMARY KEY,
  sector TEXT NOT NULL,
  sub_sector TEXT NOT NULL,
  industry TEXT NOT NULL,
  sub_industry TEXT NOT NULL,
  -- An ISO instant: when the run that wrote the row read IDX.
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;
