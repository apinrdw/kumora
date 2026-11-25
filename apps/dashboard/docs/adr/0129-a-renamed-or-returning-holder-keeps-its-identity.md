# A renamed or returning holder keeps its identity

Major holders, Daily holders and Holder moves each follow a stock's holders from one period to the next: a month of ≥1% holders, or a trading day of above-5% holders (apinrdw/kumora#673). Major holders keyed a holder by its holder key within one month and compared it only with the month before, so a holder that left the list and came back later was New with no tie to its earlier months, and one that left vanished after the month it left. IDX also renames above-5% holders from one day to the next: on 20 Nov 2026 a match by name alone shows 20 exits where the rules below show 3 (apinrdw/kumora#670).

A holder now has one identity across every period of its stock, given by `holderMoves` in `apps/dashboard/src/lib/holder-identity.ts`, the one module all three views read. Each period's holders are matched in three passes:

1. **Key.** A holder takes the identity of the holder with its key in the period before; same-key holders of one period are told apart by their order.
2. **Rename (daily only).** Of the holders left unmatched, a holder gone since the trading day before and a new one of the same stock are one holder renamed when their combined shares are equal or they share an account (custodian and account name). The new name shows "Renamed from …", and its move against the old listing follows shares as usual, so a rename with a trade is Up or Down, not an exit and an entry. Monthly ≥1% holders publish no accounts, and their rule has no rename test.
3. **Return.** A holder still unmatched whose key matches an earlier holder of the stock, not listed the period before, is that holder returning: its move is still New, since it was not listed the period before, but it keeps its identity, so it is one row in Major holders' Every month grid and never also listed in the history of earlier holders.

Every earlier holder not listed now stays below the current ones as Off list since the period after its last listing. A day whose report has no holder of the stock is a report like any other: its holders of the day before are Off list. Only a month without a report for the stock breaks the comparison.

A rename with a trade and no shared account still shows as Off list plus New. Undoing the rename pass floods Holder moves with IDX's renamings; undoing the return pass splits one investor's history into a row per listing spell in every view at once, and Holder moves' counts would no longer agree with the stock page's.

Sites:
- `apps/dashboard/src/lib/holder-identity.ts`
- `apps/dashboard/src/lib/daily-holders.ts`

Source: apinrdw/kumora#674, apinrdw/kumora#677
