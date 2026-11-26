# A single-account ambiguous count is resolved against listed shares

IDX's daily above-5% report writes most share counts as text, but its export read 1,000–999,999 as decimal-comma numbers, so a fractional number cell is ×1000 and an integer one is either itself or ×1000 (apinrdw/kumora#670). An investor's accounts must sum to its combined shares on each side, and that sum resolves every investor with several accounts. An investor with one account and an integer combined count, as MAMIP's on every day from 29 May to 20 Nov 2026, fits both readings. The parser then reads the stock's listed shares from the latest parsed investor-type report on or before the side's day (`investor_type_stock_month.shares_outstanding`) and keeps the reading whose % of them, half up to 2 decimals, equals the printed %. The side's day is the report date for the report date's counts and the trading day before for the previous day's: a stock's listed shares can change on the report date, and the previous day's % is of the shares it had then. When neither or both fit, or no such report lists the stock, the day is a parse failure. The report itself carries no listed shares, and every investor-type report since Nov 2025 lists MAMIP. So the above-5% parse run reads HoldingsDb rows another parse run writes, and a day parsed before its month's investor-type report keeps the listed shares it found then: a later investor-type report never re-parses it. Undoing this needs another source of listed shares, or leaves every such day failed.

Sites:

- `apps/dashboard/src/server/holdings/above-5.ts`

Source: apinrdw/kumora#673
