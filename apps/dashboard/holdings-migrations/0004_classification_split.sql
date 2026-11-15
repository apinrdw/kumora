-- Whether a month's report splits each classification into local and
-- foreign (Sep 2026 onward), as the parse read its header row. A stock
-- holding no scripless shares has no holding rows, so its rows can't tell.
-- 1 or 0.
ALTER TABLE classification_month
ADD COLUMN split INTEGER NOT NULL DEFAULT 0 CHECK (split IN (0, 1));

-- Months parsed before this column: a month with any local or foreign row
-- splits. PARSER_VERSION 2 parses each again and records the header's.
UPDATE classification_month SET split = EXISTS (
  SELECT 1 FROM classification_holding h
  WHERE h.data_date = classification_month.data_date
    AND h.origin <> 'combined'
);
