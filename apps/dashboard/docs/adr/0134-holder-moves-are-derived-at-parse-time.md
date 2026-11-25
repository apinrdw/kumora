# Holder moves are derived at parse time

The Holder moves page lists every holder that moved in one period across the market, with its 20-period Trend, and a rail of the last 10 periods' counts: above-5% holders on a trading day (Daily), or ≥1% holders in a report month (Monthly). Reading it on demand meant loading every moving stock's 21 periods at once. Real days already read 46,000 to 59,000 account rows (20 Nov and 12 Oct 2026, from 263 to 343 moving stocks), over 100 MiB of a Worker's 128 MiB, and 586 MiB at the parse's caps. A real month has 7,150 rows across 960 stocks (Sep 2026), so 21 months of moving stocks read up to about 150,000 rows, and 315,000 at the above-1% parse's caps.

Each kind's parse run now derives its periods' moves after its parse steps, in one `derive:<date>` step per period, and stores them as lines: the above-5% parse run in `above_5_move` (`holdings-migrations/0011_above_5_move.sql`), the above-1% parse run in `above_1_move` (`0012_above_1_move.sql`), with the same columns. The page reads one period's lines and one count per rail period and move. A Monthly period is one above-1% report, by its data date. A calendar month that holds two reports shows its newest: on Holder moves the newest report of the month, and on a stock's Major holders the newest that holds the stock (`monthReports` in `lib/major-holders.ts`), which is the one tab the month has there. The two agree wherever Holder moves links: a stock with a line in a report is in it, so its month opens that report. A stock in the month's older report only has no line in the newer one, and its panel shows the older, where opening the empty newer one sent the month's tab to another month (apinrdw/kumora#673's review). Holder moves leaves the older report out of its periods and its rail, since a month is selected by its `YYYY-MM` and opens the newest. A period's lines come from the stock's own panel view model, run over the stock's periods as the panel reads them up to that period (`server/holdings/holders-window.ts`, ADR 0133). So Holder moves and the panel give a holder one identity and one Trend:
- a day's from Daily holders (`lib/daily-holders.ts`);
- a month's from Major holders (`lib/major-holders.ts`).

Each derived period records its basis: a digest of the derivation's version and of the version of every parsed period up to it. A holder's identity comes from every period read before it (ADR 0129), and a stock's read reaches back as far as its budget fits, so a period depends on all of them. `derive-reconcile` picks every period whose basis differs. So a period newly parsed or parsed again re-derives itself and every period after it, and a parser version bump re-derives every period. A period that fails to parse keeps its rows and its basis, so its lines stay.

Both kinds share one derivation (`server/holdings/derived-moves.ts`). Stocks are read in turns whose rows fit the kind's row budget and decoded one stock at a time. Each turn's lines are staged in the kind's `_pending` table, and one batch then swaps the period's staged lines in, so a reader or a failed attempt sees a period's lines whole. Through is stored as custodian names, and broker codes are still looked up on read (ADR 0132). A month's read leaves out the row labels a line doesn't store, since a read's rows set the heap.

`tests/server/holdings/holder-moves-heap.test.ts` checks the bounds at each parse's caps, in a worker whose heap stops at 72 MiB, about 25 MiB of it the worker's own:
- a day: 16,000 lines from 21 days of 8,000 rows; it fit 64 MiB, not 56, on 25 Nov 2026, and reads in under 32 MiB;
- a month: 30,000 lines from 21 months of 15,000 rows; it fit 72 MiB, not 64, and reads in under 48 MiB (39.5 MiB measured).

The cost is one more step per derived period in a run, twice the rows written for each line, and a derivation whose reads grow with the parsed periods: it reads each moving stock's every period that fits the budget, where its Trend alone read 21. By the days above, that is about 2,500 more securities account rows a derived day for each parsed day before it, read in turns of the budget's rows. Undoing this means reading moves on demand again, which needs another bound on the read, such as computing the rail's counts at parse time and reading fewer trend periods.

Sites:
- `apps/dashboard/src/server/holdings/derived-moves.ts`
- `apps/dashboard/src/server/holdings/above-5-moves.ts`
- `apps/dashboard/src/server/holdings/above-1-moves.ts`
- `apps/dashboard/src/server/holdings/holder-moves.ts`
- `apps/dashboard/src/lib/major-holders.ts`
- `apps/dashboard/src/server/shareholding/above-5-parse.ts`
- `apps/dashboard/src/server/shareholding/above-1-parse.ts`
- `apps/dashboard/tests/server/holdings/holder-moves-heap.test.ts`

Source: apinrdw/kumora#673
