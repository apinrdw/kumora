-- The trades each broker bought and sold in, which the broker summary's
-- Freq column shows. apinrdw/kumora#465.
-- Decision: a forward migration, not an edit of an applied one: Alchemy
-- refuses edited applied migrations. A day built before it reads 0 trades
-- until the reconcile rebuilds it at the bumped build version.
ALTER TABLE totals ADD COLUMN buy_freq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE totals ADD COLUMN sell_freq INTEGER NOT NULL DEFAULT 0;
