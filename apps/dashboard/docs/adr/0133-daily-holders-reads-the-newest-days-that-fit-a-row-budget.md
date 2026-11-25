# Daily holders reads the newest days that fit a row budget

The stock page's Daily holders panel needs a stock's above-5% days: the selected day and the one before for its moves, the 20 up to it for each holder's Trend, and every earlier day for the history of earlier holders. Reading every day grows with every parsed day, and one day of a stock can hold up to the parse's 8,000 rows (ADR 0045), each an account in a block of its own, so the read and the loader data it sends had no bound. The read now takes the stock's newest parsed days whose rows fit `DAILY_HOLDERS_ROWS`, a day costing its own row plus its blocks' and accounts' rows. The budget is two days at the cap, 32,002 rows, so the newest day and the one before always fit and the newest day's moves are always right. On real data it holds far more: the busiest stock on 25 Nov 2026 (DNET) has at most 38 accounts a day, so about three years of days fit. The panel's day picker, Trend and history cover only the days read; past the budget the oldest days drop out of all three, and a URL naming such a day opens the newest. `tests/server/holdings/stock-page-heap.test.ts` reads the budget at the cap's longest texts and keeps it under 32 MiB of heap, a quarter of the Worker's 128 MiB (21 MiB measured on 25 Nov 2026). Holder moves' derivation (ADR 0134) reads each stock's days by the same budget, so a day's lines match its Daily holders. Undoing this means another bound on the read, such as reading by the selected day, which reloads the whole stock page on each day picked.

Sites:
- `apps/dashboard/src/server/holdings/stock-page.ts`
- `apps/dashboard/src/server/holdings/above-5-moves.ts`
- `apps/dashboard/tests/server/holdings/stock-page-heap.test.ts`

Source: apinrdw/kumora#673
