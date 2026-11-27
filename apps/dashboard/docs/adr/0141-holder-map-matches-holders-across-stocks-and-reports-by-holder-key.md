# The Holder map matches holders across stocks and reports by holder key

The stock page and Holder moves follow a holder within one stock, through each report on its own: a ≥1% holder month to month, an above-5% holder day to day, with renames and returns matched by ADR 0129's passes, and never an above-5% holder to a ≥1% holder. The Holder map (apinrdw/kumora#733) draws who holds what around a stock, a holder or a custodian, so it needs one holder across stocks and across the two reports: an above-5% holder of the as-of day and a ≥1% holder of the month before it are drawn once, in the 5% band, and a holder's other stocks are found by its name.

On the Holder map a holder is its holder key (`server/holdings/holder-key.ts`), the key both parsers already store and the above-1% table already indexes (`above_1_holding_by_holder`). Within one stock's day, an investor's repeat blocks are first collapsed as Daily holders collapses them (ADR 0131), and the blocks left that share a key are one holder, their % and shares summed, as a month's rows sharing a key are one ≥1% holder. The 1%-to-5% band is the month's ≥1% holders whose key no block of the stock that day carries, so a holder in both reports shows once, in the 5% band, and one at 5% or more in the month with no block that day stays in the 1% band. A 5%-band holder takes its KSEI investor type from its ≥1% rows of the month, since the above-5% report publishes none. Across stocks, a later focus (a holder, its other stocks) matches by the same key.

The stock page and Holder moves keep their own rule: ADR 0129's identity within a stock and the glossary's "never matched to a ≥1% holder". The cost is false merges: two unrelated investors of one name, such as CPGT's two blocks of ASIA ARGENTUM ASSETS HONG KONG LIMITED, show as one holder, and a holder renamed beyond what the key ignores shows as two. The owner accepted both in the spec's grilling. Undoing this means storing an investor identity across reports, which neither IDX report publishes (the above-5% report's SID is not stored), and drawing a holder per stock and report, which leaves the map with no edges between stocks.

Sites:

- `apps/dashboard/src/server/holdings/holder-map.ts`

Source: apinrdw/kumora#733, apinrdw/kumora#734
