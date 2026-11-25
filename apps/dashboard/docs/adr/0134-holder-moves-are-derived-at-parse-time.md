# Holder moves are derived at parse time

The Holder moves page lists every holder that moved in one period across the market, with its 20-period Trend, and a rail of the last 10 periods' counts: above-5% holders on a trading day (Daily), or ≥1% holders in a report month (Monthly). Reading it on demand meant loading every moving stock's 21 periods at once. Real days already read 46,000 to 59,000 account rows (20 Nov and 12 Oct 2026, from 263 to 343 moving stocks), over 100 MiB of a Worker's 128 MiB, and 586 MiB at the parse's caps. A real month has 7,150 rows across 960 stocks (Sep 2026), so 21 months of moving stocks read up to about 150,000 rows, and 315,000 at the above-1% parse's caps.

Each kind's parse run now derives its periods' moves after its parse steps, in one `derive:<date>` step per period, and stores them as lines: the above-5% parse run in `above_5_move` (`holdings-migrations/0011_above_5_move.sql`), the above-1% parse run in `above_1_move` (`0012_above_1_move.sql`), with the same columns. The page reads one period's lines and one count per rail period and move. A period's lines come from the stock's own panel view model run over the stock's 21 parsed periods up to that period, so Holder moves and the panel can't disagree:
- a day's from Daily holders (`lib/daily-holders.ts`), trimmed to the stock page's row budget (ADR 0133);
- a month's from Major holders (`lib/major-holders.ts`), trimmed to a stock's month and the month before at the parse's cap. Only a stock past that cap would show a shorter Trend than its Major holders panel.

Each derived period records its basis: the derivation's version and the version of each of the 21 parsed periods it read. `derive-reconcile` picks every period whose basis differs. So a period newly parsed or parsed again re-derives itself and the 20 periods after it whose Trends read it, and a parser version bump re-derives every period. A period that fails to parse keeps its rows and its basis, so its lines stay.

Both kinds share one derivation (`server/holdings/derived-moves.ts`). Stocks are read in turns whose rows fit the kind's row budget and decoded one stock at a time. Each turn's lines are staged in the kind's `_pending` table, and one batch then swaps the period's staged lines in, so a reader or a failed attempt sees a period's lines whole. Through is stored as custodian names, and broker codes are still looked up on read (ADR 0132). A month's read leaves out the row labels a line doesn't store, since a read's rows set the heap.

`tests/server/holdings/holder-moves-heap.test.ts` checks the bounds at each parse's caps, in a worker whose heap stops at 72 MiB, about 25 MiB of it the worker's own:
- a day: 16,000 lines from 21 days of 8,000 rows; it fit 64 MiB, not 56, on 25 Nov 2026, and reads in under 32 MiB;
- a month: 30,000 lines from 21 months of 15,000 rows; it fit 72 MiB, not 64, and reads in under 48 MiB (39.5 MiB measured).

The cost is one more step per derived period in a run, and twice the rows written for each line. Undoing this means reading moves on demand again, which needs another bound on the read, such as computing the rail's counts at parse time and reading fewer trend periods.

Sites:
- `apps/dashboard/src/server/holdings/derived-moves.ts`
- `apps/dashboard/src/server/holdings/above-5-moves.ts`
- `apps/dashboard/src/server/holdings/above-1-moves.ts`
- `apps/dashboard/src/server/holdings/holder-moves.ts`
- `apps/dashboard/src/server/shareholding/above-5-parse.ts`
- `apps/dashboard/src/server/shareholding/above-1-parse.ts`
- `apps/dashboard/tests/server/holdings/holder-moves-heap.test.ts`

Source: apinrdw/kumora#673
