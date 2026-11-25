-- Holder moves' Monthly lines, derived from the parsed above-1% months
-- (0007_above_1.sql) by the above-1% parse run, after its months are parsed
-- (src/server/holdings/above-1-moves.ts), so the Holder moves page reads one
-- month's lines in place of every moving stock's months. Each line is a
-- stock's holder that moved that report month, as the stock's Major holders
-- shows it (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md).
-- Its columns are above_5_move's (0011_above_5_move.sql), so both kinds
-- are read alike. Spec apinrdw/kumora#673, "Holder moves".

-- A holder listed that month with a move (New, Up or Down), or listed the
-- parsed month before and not now (Off list). Unchanged holders, and every
-- holder of a stock's first month or of a month after its gap, have none.
CREATE TABLE above_1_move (
  data_date TEXT NOT NULL,
  stock_code TEXT NOT NULL,
  -- Its identity across the stock's months (src/lib/holder-identity.ts).
  holder TEXT NOT NULL,
  -- As the newest of the stock's months it was derived from prints it.
  issuer_name TEXT NOT NULL,
  -- Its largest row's name that month, or its last listing's when off the
  -- list.
  name TEXT NOT NULL,
  -- Always '[]' and NULL: a month has no repeat blocks nor renames.
  aliases TEXT NOT NULL,
  renamed_from TEXT,
  move TEXT NOT NULL CHECK (move IN ('new', 'up', 'down', 'off list')),
  -- Always '[]': the above-1% report has no accounts.
  through TEXT NOT NULL,
  -- Against the month before, in shares: a New holder's whole holding, an
  -- Off-list one's last, negated.
  share_change INTEGER,
  -- % × 100, the month before's and this month's; NULL where it isn't
  -- listed.
  stake_before INTEGER,
  stake_now INTEGER,
  percentage_change INTEGER,
  -- A JSON array: its Trend, the last 20 report months up to this one.
  trend TEXT NOT NULL,
  PRIMARY KEY (data_date, stock_code, holder)
) WITHOUT ROWID;

-- A month's lines as its derivation finds them, a read of stocks at a
-- time, before one batch swaps them into above_1_move: a reader sees a
-- month's lines whole.
CREATE TABLE above_1_move_pending (
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

-- The rail counts each month's lines by move.
CREATE INDEX above_1_move_by_move ON above_1_move (data_date, move);

-- A month whose lines are derived: the parsed month they are against, and
-- what they were derived from. The run derives a month again when its
-- basis, the derivation's version and the version of each parsed month its
-- lines read, differs.
CREATE TABLE above_1_move_month (
  data_date TEXT NOT NULL PRIMARY KEY,
  -- NULL on the first parsed month, which has no moves.
  against TEXT,
  basis TEXT NOT NULL
);
