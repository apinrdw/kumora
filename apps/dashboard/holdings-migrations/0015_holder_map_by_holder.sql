-- The Holder map (spec apinrdw/kumora#733, "Read budget"; apinrdw/kumora#738)
-- reads a holder's stocks across the market by its holder key: the day's
-- above-5% blocks of the key, as above_1_holding_by_holder finds the
-- month's rows, and a holder focus's Off list from the stored lines of
-- every identity first listed under its key (`<key>#<n>`,
-- src/lib/holder-identity.ts). The tables' keys lead with the date, so
-- without these each read scans every stock's rows of the day or every
-- stored line (src/server/holdings/holder-map.ts).
CREATE INDEX above_5_holder_by_holder
ON above_5_holder (holder_key, data_date);

CREATE INDEX above_5_move_by_holder ON above_5_move (holder, data_date);
CREATE INDEX above_1_move_by_holder ON above_1_move (holder, data_date);
