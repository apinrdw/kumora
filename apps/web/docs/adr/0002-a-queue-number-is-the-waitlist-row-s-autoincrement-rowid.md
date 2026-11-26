# A queue number is the waitlist row's AUTOINCREMENT rowid

The waitlist has one row per email, normalized by trimming and lowercasing, so `Ana@Example.com ` and `ana@example.com` are one visitor. The email column is `UNIQUE`. A visitor who joins again gets their first row back: the same queue number and join time, and no second row.

The queue number is the row's `INTEGER PRIMARY KEY AUTOINCREMENT`, the rowid. SQLite assigns it inside the INSERT, so it needs no separate counter, and D1 runs the join's insert and its read in one transaction on a single writer, so two concurrent joins never share a number. AUTOINCREMENT, unlike a plain rowid, never hands out a number again, even the highest one after its row is deleted. A visitor never sees a number that was already shown to someone else.

The join inserts only when the email has no row (`INSERT ... SELECT ... WHERE NOT EXISTS`). An `ON CONFLICT DO NOTHING` insert would still advance AUTOINCREMENT's counter, so every return visit would burn a number. The table is created by `apps/web/waitlist-migrations/0001_waitlist.sql`.

We rejected these alternatives:

- `COALESCE(MAX(number), 0) + 1` in the INSERT. It is atomic on D1 too, but it reuses the highest number after a delete.
- A counter row updated with each join. It is a second write per join, and it can drift from the table.

Sites:

- `apps/web/src/server/waitlist/waitlist.ts`

Source: none
