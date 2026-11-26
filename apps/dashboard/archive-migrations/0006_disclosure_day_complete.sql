-- When a disclosure day became complete (spec apinrdw/kumora#715, ticket
-- #718): a day more than 7 days old, listed after it ended, with nothing of
-- it waiting to be stored. A run never lists a complete day again
-- (apps/dashboard/docs/adr/0138).
-- An ISO instant; null while the day isn't complete.
ALTER TABLE disclosure_day ADD COLUMN complete_at TEXT;
