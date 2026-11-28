-- The Holder map (spec apinrdw/kumora#733, "Read budget"; apinrdw/kumora#739)
-- reads a custodian focus's stocks across the market: the day's securities
-- accounts at the custodian's spellings. The table's key leads with the
-- date and the stock, so without this the read scans every account of the
-- day (src/server/holdings/holder-map.ts).
CREATE INDEX above_5_account_by_custodian
ON above_5_account (custodian, data_date);
