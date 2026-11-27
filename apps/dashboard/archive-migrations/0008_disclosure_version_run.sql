-- The run that indexed each disclosure version (spec apinrdw/kumora#715), so
-- a listing step counts the versions its run added from the index: a retry
-- that finds its first attempt's rows counts them as that attempt would.
-- Null for a version indexed before this column.
ALTER TABLE disclosure_version ADD COLUMN run_id TEXT;
