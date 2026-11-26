-- A Daily holder move may be a Transfer (apinrdw/kumora#700): an above-5%
-- holder whose total is unchanged moved shares from accounts at some
-- custodians to accounts at others. SQLite can't widen above_5_move's CHECK
-- in place, so the table is rebuilt with it; the above-5% parse run then
-- derives every day again (src/server/holdings/above-5-moves.ts's version).
-- Both kinds' lines keep one set of columns, so above_1_move gains
-- `transfer` too, always NULL: the above-1% report has no accounts.

CREATE TABLE above_5_move_next (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- Its identity across the stock's days (src/lib/holder-identity.ts).
  holder TEXT NOT NULL,
  -- As the newest of the stock's days it was derived from prints it.
  issuer_name TEXT NOT NULL,
  -- Its name that day, or its last listing's when off the list.
  name TEXT NOT NULL,
  -- A JSON array: the names of its collapsed repeat blocks.
  aliases TEXT NOT NULL,
  -- Its name the day before, when renamed since.
  renamed_from TEXT,
  move TEXT NOT NULL
    CHECK (move IN ('new', 'up', 'down', 'transfer', 'off list')),
  -- A JSON array: the custodians of the accounts the move went through,
  -- largest change first. Their broker codes are looked up on read
  -- (apps/dashboard/docs/adr/0132-broker-codes-are-looked-up-on-read.md).
  through TEXT NOT NULL,
  -- Against the day before, in shares.
  share_change INTEGER,
  -- % × 100, the day before's and this day's; NULL where it isn't listed.
  stake_before INTEGER,
  stake_now INTEGER,
  percentage_change INTEGER,
  -- A JSON array: its Trend, the last 20 trading days up to this one.
  trend TEXT NOT NULL,
  -- On a Transfer, a JSON object: the custodians its shares left (`from`)
  -- and reached (`to`), most shares first, and the shares that moved
  -- (`shares`). NULL on any other move.
  transfer TEXT,
  PRIMARY KEY (data_date, stock_code, holder)
) WITHOUT ROWID;

INSERT INTO above_5_move_next (
  data_date, stock_code, holder, issuer_name, name, aliases, renamed_from,
  move, through, share_change, stake_before, stake_now, percentage_change,
  trend
)
SELECT data_date, stock_code, holder, issuer_name, name, aliases,
  renamed_from, move, through, share_change, stake_before, stake_now,
  percentage_change, trend
FROM above_5_move;

DROP INDEX above_5_move_by_move;
DROP TABLE above_5_move;
ALTER TABLE above_5_move_next RENAME TO above_5_move;
CREATE INDEX above_5_move_by_move ON above_5_move (data_date, move);

ALTER TABLE above_5_move_pending ADD COLUMN transfer TEXT;
ALTER TABLE above_1_move ADD COLUMN transfer TEXT;
ALTER TABLE above_1_move_pending ADD COLUMN transfer TEXT;
