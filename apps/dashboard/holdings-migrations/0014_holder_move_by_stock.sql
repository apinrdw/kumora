-- The Holder map (spec apinrdw/kumora#733, "Read budget"; apinrdw/kumora#736)
-- reads one stock's earlier holders from its stored Off-list and New lines
-- up to the as-of day and month (src/server/holdings/holder-map.ts). The
-- lines' keys lead with the date, so without these the read scans every
-- stock's lines.
CREATE INDEX above_5_move_by_stock ON above_5_move (stock_code, move, data_date);
CREATE INDEX above_1_move_by_stock ON above_1_move (stock_code, move, data_date);
