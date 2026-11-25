-- Holder moves' Daily lines, derived from the parsed above-5% days
-- (0010_above_5.sql) by the above-5% parse run, after its days are parsed
-- (src/server/holdings/above-5-moves.ts), so the Holder moves page reads one
-- day's lines in place of every moving stock's days. Each line is a stock's
-- holder that moved that trading day, as the stock's Daily holders shows
-- it (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md).
-- Spec apinrdw/kumora#673, "Holder moves".

-- A holder listed that day with a move (New, Up or Down), or listed the
-- parsed day before and not now (Off list). Unchanged holders, and every
-- holder of the first parsed day, have none.
CREATE TABLE above_5_move (
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
  move TEXT NOT NULL CHECK (move IN ('new', 'up', 'down', 'off list')),
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
  PRIMARY KEY (data_date, stock_code, holder)
) WITHOUT ROWID;

-- A day's lines as its derivation finds them, a read of stocks at a time,
-- before one batch swaps them into above_5_move: a reader sees a day's
-- lines whole.
CREATE TABLE above_5_move_pending (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  holder TEXT NOT NULL,
  issuer_name TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  renamed_from TEXT,
  move TEXT NOT NULL,
  through TEXT NOT NULL,
  share_change INTEGER,
  stake_before INTEGER,
  stake_now INTEGER,
  percentage_change INTEGER,
  trend TEXT NOT NULL,
  PRIMARY KEY (data_date, stock_code, holder)
) WITHOUT ROWID;

-- The rail counts each day's lines by move.
CREATE INDEX above_5_move_by_move ON above_5_move (data_date, move);

-- A day whose lines are derived: the parsed day they are against, and what
-- they were derived from. The run derives a day again when its basis, the
-- derivation's version and the version of each parsed day its lines read,
-- differs.
CREATE TABLE above_5_move_day (
  data_date TEXT NOT NULL PRIMARY KEY,
  -- NULL on the first parsed day, which has no moves.
  against TEXT,
  basis TEXT NOT NULL
);
