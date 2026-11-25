# A returning holder rejoins its history

Major holders, Daily holders and Holder moves each follow a stock's holders from one period to the next: a month of ≥1% holders, or a trading day of above-5% holders (apinrdw/kumora#673). Major holders keyed a holder by its holder key within one month and compared it only with the month before, so a holder that left the list and came back later was New with no tie to its earlier months, and one that left vanished after the month it left.

A holder now has one identity across every period of its stock, given by `holderMoves` in `apps/dashboard/src/lib/holder-identity.ts`, the one module all three views read. A holder takes the identity of the holder with its key in the period before; same-key holders of one period are told apart by their order. A holder not matched there whose key matches an earlier holder of the stock, not listed the period before, is that holder returning: its move is still New, since it was not listed the period before, but it keeps its identity, so it is one row in Major holders' Every month grid and never also listed in the history of earlier holders. Every earlier holder not listed now stays below the current ones as Off list since the period after its last listing.

Undoing this splits one investor's history into a row per listing spell in every view at once, and Holder moves' counts would no longer agree with the stock page's.

Sites:
- `apps/dashboard/src/lib/holder-identity.ts`

Source: apinrdw/kumora#674
