# Above-5% repeat blocks are stored as published

Until 19 Nov 2026 IDX's daily above-5% report repeats an investor's block once per name variant, 62–71 extra blocks a day, with the same accounts and shares (apinrdw/kumora#670). The parser stores every block as published, one `above_5_holder` row per block keyed by the report's `No` (`holdings-migrations/0010_above_5.sql`), and never merges blocks or checks a stock's % summing to at most 100. The pages collapse a block whose accounts and combined shares equal an earlier block's of the same stock-day into one holder when they read it, its name an alias. Stored as published, a day's rows are the file's, and a change to the collapse rule reaches every past day on its next read without a re-parse. Undoing this means merging at parse time, which loses the aliases and needs a parser version bump to reach old days.

Sites:
- `apps/dashboard/src/server/holdings/above-5.ts`
- `apps/dashboard/src/lib/daily-holders.ts`

Source: apinrdw/kumora#673
