-- The trades each stock's regular-board day counted, walk-filled ones too,
-- which the broker summary's footer shows. Spec apinrdw/kumora#437, story 30.
-- Decision: a forward migration, not an edit of 0001: a Preview applied 0001
-- before the column existed, and Alchemy refuses edited applied migrations.
-- A day built before it reads 0 trades; only that Preview holds one.
ALTER TABLE candles ADD COLUMN trades INTEGER NOT NULL DEFAULT 0;
