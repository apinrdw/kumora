# A stock's holders are read from its newest periods that fit a row budget

A stock's panel follows its holders across periods: Daily holders across above-5% days, Major holders across above-1% months. Each needs the selected period and the one before for its moves, the 20 up to it for each holder's Trend, and every earlier period for the earlier holders and for a holder's identity, which comes from every period read before it (ADR 0129). Reading every period grows with every parsed one, and one period of a stock can hold up to the parse's cap of rows (ADR 0045): 8,000 a day, each a securities account in a block of its own, or 15,000 a month. So the read and the loader data it sends had no bound.

Every reader of a kind's periods now takes them from one definition, the windows in `server/holdings/holders-window.ts`: the stock's newest parsed periods up to a given one whose rows fit a budget. A period costs its own row plus its holders' rows: a day's blocks and securities accounts, a month's holdings. A kind read alone has a budget of two periods at the cap, 32,002 rows of days and 30,002 of months, so a period and the one before always fit and its moves are always right. On real data it holds far more. The busiest stock on 25 Nov 2026 (DNET) has at most 38 securities accounts a day, so about three years of days fit. A stock has at most 28 rows a month (Sep 2026), so every month fits. The months read are also at most 240, 20 years of them (`periods`): Major holders renders a tab and an Every month column for each month read, and the row budget alone holds 15,001 months of one holder, whose render took over 88 MiB of heap.

- Holder moves' derivation (ADR 0134) reads one kind, each moving stock up to the period it derives, within the kind's budget (`readFrom`).
- The stock page reads both kinds of one stock up to their newest parsed periods, within one budget they share (`pageReadFrom`): 36,002 rows, two days at the cap and 4,000 rows beside them. The months are read first, as alone, and the days fit what the months leave, at most their own budget. A real stock's months are few rows, 11 years of them in the 4,000, so its days keep their whole budget. A panel's picker, Trend and earlier holders cover only the periods read. Past the budget the oldest periods drop out of all three, and a URL naming such a period opens the newest.

A period's lines and its panel then read the same periods, so a holder has one identity and one Trend in both. That holds while the stock's periods up to the newest fit the page's budget. Past it the panel starts at a later period than the derivation did, and a holder back from before the panel's first period can show a shorter Trend there. A stock with over 4,000 rows of months beside two days at the cap shows fewer days than Holder moves derived from, down to none at both caps. The two budgets apart let one stock's page read 62,004 rows, which took 144 MiB of heap, more than a Worker has (apinrdw/kumora#673's review). No real stock comes near either cap: at most 20 holders can be above 5% and 100 above 1%.

What a panel renders of its rows has one bound too. A list of stored rows is rendered through `BoundedRows` (`components/k/bounded-rows.tsx`): the list's first 200 rows, then a line that says how many it holds and a button that shows 200 more. So the server render holds 200 rows of a list, whatever its length. Rendered whole, a day at the cap (8,000 holders of a securities account each) took more than a Worker's 128 MiB in React's server render alone (apinrdw/kumora#673's review). Through it go:
- Daily holders' table, as one list: each holder, a listed one's securities accounts under it, then the earlier holders under their heading;
- Major holders' table, and its Every month grid. The grid starts with as many rows as fit 6,000 cells, so fewer for more months (100 rows of 60 months), and works out a row's cells when it renders the row (`cellsOf` in `lib/every-month.ts`): every row's cells at once are holders times months, which no row budget bounds;
- Holder moves' table and its Entered or left list (ADR 0134).

The ownership bar draws a segment for each of its first 100 holders and one for the rest. A real stock's day stays under the bound unless it has well over a hundred earlier holders, which no stock's parsed days were checked for: at most 20 holders can be above 5%, and the busiest stock has 38 securities accounts (DNET, 25 Nov 2026). A real month has at most 28 rows. Holder moves' table does pass it on a real day.

The view model keeps what grows with the periods' holders, not with periods times holders: `holderMoves` (`lib/holder-identity.ts`) holds each period's own holders, and `earlierHolders` works out the earlier holders of the one period shown. `tests/server/holdings/stock-page-heap.test.ts` holds the bounds:
- The read of two days at the cap's longest texts retains under 32 MiB (21 MiB measured on 25 Nov 2026), and of two months under 48 MiB (31.6 MiB).
- The read of both kinds and the render of both panels fit a worker whose heap stops at 96 MiB (`stock-page-worker.tsx`), about 30 MiB of it the worker's own, React with it. Every case fit 88 MiB on 25 Nov 2026 and the tightest not always 84; a worker thread's limit isn't exact, so the bound leaves room. The cases:
  - the page's budget: at both caps, with two months at the cap and the days that fit beside them, and with two days at the cap and 4,000 rows of months. A month's rows are let go as its holders are made of them (`drained` in `server/holdings/stock-page.ts`): held whole beside the holders, the read alone of the second fit 112 MiB, not 104;
  - Daily holders' three extremes: 450 days of 19 new holders each, whose read and view model took 181 MiB while each day kept its own list of earlier holders; 10,667 days of one new holder each; and two days at the cap with every holder new;
  - Major holders' two: 240 months of 124 new holders each, the most rows of the most months, and a stock with more months than 240.

Undoing this means another bound on the read, such as reading by the selected period, which reloads the whole stock page on each period picked. It also means a second definition of the periods the derivation reads. With its own, the last 21 periods, Holder moves gave a holder renamed before them and back within them a Trend its panel didn't show (apinrdw/kumora#673's review).

Sites:
- `apps/dashboard/src/components/k/bounded-rows.tsx`
- `apps/dashboard/src/server/holdings/holders-window.ts`
- `apps/dashboard/src/server/holdings/stock-page.ts`
- `apps/dashboard/tests/server/holdings/stock-page-heap.test.ts`

Source: apinrdw/kumora#673
