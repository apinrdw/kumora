# The Ajaib tape walk pages the whole day at 50,000 then 49,999 rows

The walk of the newest closed day on Ajaib's REST tape (`running_trades/`) used to walk it one 3-minute block at a time at 5,000 rows a page, then walk every block that took 2+ pages again at 4,999: about 800 calls and tens of minutes, which gave a token that long to go stale. It now walks the whole day the way the owner's console collector does: one fixed `last_timestamp` (the walk's start plus one hour, since `last_timestamp` filters on a hidden time and is no cursor), `direction=DESC`, a first pass at 50,000 rows a page and a second at 49,999. Page k starts at offset (k−1)·(P+1) and holds P rows, so each pass skips one trade per page boundary, and the two passes skip different ones. A pass ends at a page that answers fewer rows than asked or says no page follows, and at 100 pages at most. Probed on 2026-11-26 at 200,000 / 199,999: 12 calls, 130 s, every trade but the 22 IDX never printed. 50,000 and not 200,000: a 200,000-row page is about 60 MB and took 6 to 20 s, past the relay's 15 s request timeout, and that much would cross the tab-to-worker message on every page; 50,000 keeps a page near 15 MB, about 46 calls a day.

The walk keeps its position, `{ day, pass, page, lastTimestamp }`, in `chrome.storage.local` after each page, so a restarted worker resumes on the same `last_timestamp` and its pages line up with those before the restart. A position kept in the old block shape doesn't decode and the day is walked afresh; Production keeps the trades it already holds. Each page's rows go up as consecutive batches of at most `BATCH_ROWS` (packages/relay ADR 0012).

Sites:
- `apps/extension/src/worker/broker-codes/ajaib-walk.ts`

Source: apinrdw/kumora#711
