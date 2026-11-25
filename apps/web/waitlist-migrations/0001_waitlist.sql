-- The waitlist: one row per normalized email (trimmed, lowercased), so a
-- visitor who joins again gets their row back, not a second one.
-- apps/web/docs/adr/0002-a-queue-number-is-the-waitlist-row-s-autoincrement-rowid.md
-- says why the queue number is the rowid.
CREATE TABLE waitlist (
  -- The queue number, 1 for the first visitor to join. AUTOINCREMENT: SQLite
  -- assigns it inside the INSERT, and never hands out a number again, even
  -- the highest one after its row is deleted.
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  -- The landing page's language when the visitor joined.
  lang TEXT NOT NULL CHECK (lang IN ('en', 'id')),
  -- Epoch milliseconds.
  joined_at INTEGER NOT NULL
) STRICT;
