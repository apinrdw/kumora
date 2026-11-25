# A stock's holders are read from its newest periods that fit a row budget

A stock's panel follows its holders across periods: Daily holders across above-5% days, Major holders across above-1% months. Each needs the selected period and the one before for its moves, the 20 up to it for each holder's Trend, and every earlier period for the earlier holders and for a holder's identity, which comes from every period read before it (ADR 0129). Reading every period grows with every parsed one, and one period of a stock can hold up to the parse's cap of rows (ADR 0045): 8,000 a day, each a securities account in a block of its own, or 15,000 a month. So the read and the loader data it sends had no bound.

Every reader of a kind's periods now takes them from one definition, `readFrom` in `server/holdings/holders-window.ts`: the stock's newest parsed periods up to a given one whose rows fit the kind's budget. A period costs its own row plus its holders' rows: a day's blocks and securities accounts, a month's holdings. The budget is two periods at the cap, 32,002 rows of days and 30,002 of months, so a period and the one before always fit and its moves are always right. On real data it holds far more. The busiest stock on 25 Nov 2026 (DNET) has at most 38 securities accounts a day, so about three years of days fit. A stock has at most 28 rows a month (Sep 2026), so every month fits.

- The stock page reads a stock up to its newest parsed period. A panel's picker, Trend and earlier holders cover only the periods read. Past the budget the oldest periods drop out of all three, and a URL naming such a period opens the newest.
- Holder moves' derivation (ADR 0134) reads each moving stock up to the period it derives. A period's lines and its panel then read the same periods, so a holder has one identity and one Trend in both. That holds while the stock's periods up to the newest fit the budget. Past it the panel starts at a later period than the derivation did, and a holder back from before the panel's first period can show a shorter Trend there.

The view model keeps what grows with the periods' holders, not with periods times holders: `holderMoves` (`lib/holder-identity.ts`) holds each period's own holders, and `earlierHolders` works out the earlier holders of the one period shown. `tests/server/holdings/stock-page-heap.test.ts` holds the bounds:
- The read of two days at the cap's longest texts retains under 32 MiB (21 MiB measured on 25 Nov 2026), and of two months under 48 MiB (31.6 MiB).
- The read and the Daily holders view model together fit a worker whose heap stops at 88 MiB, about 25 MiB of it the worker's own. The test runs the budget's three extremes: 450 days of 19 new holders each, which took 181 MiB while each day kept its own list of earlier holders; 10,667 days of one new holder each; and two days at the cap with every holder new, which fit 80 MiB, not 72.

Undoing this means another bound on the read, such as reading by the selected period, which reloads the whole stock page on each period picked. It also means a second definition of the periods the derivation reads. With its own, the last 21 periods, Holder moves gave a holder renamed before them and back within them a Trend its panel didn't show (apinrdw/kumora#673's review).

Sites:
- `apps/dashboard/src/server/holdings/holders-window.ts`
- `apps/dashboard/src/server/holdings/stock-page.ts`
- `apps/dashboard/tests/server/holdings/stock-page-heap.test.ts`

Source: apinrdw/kumora#673
