-- The trades of 1..N a built day missed when it was built, at most 0.1% of
-- them, which the broker summary's footer shows. apinrdw/kumora#457.
-- Decision: a forward migration, not an edit of an applied one: Alchemy
-- refuses edited applied migrations. A day built before it reads 0, as
-- only a day with every trade held built then.
ALTER TABLE built_days ADD COLUMN missing_trades INTEGER NOT NULL DEFAULT 0;
