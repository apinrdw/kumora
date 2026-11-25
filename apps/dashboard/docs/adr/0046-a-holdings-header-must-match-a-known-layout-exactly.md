# A holdings header must match a known layout exactly

IDX and KSEI write their report headers the same way month after month: the above-1% report across 9 months, the investor-type report in all 12 months of each layout, and KSEI's file from Jan 2008 to Oct 2026. So a header must match a known layout's every label exactly (KSEI's byte for byte), or the month fails. Any other label is a layout change, not a variant to tolerate, and failing means a changed layout never stores wrong numbers. The daily above-5% report is held to the same rule: a header or subheader that differs fails the day.

Sites:
- `apps/dashboard/src/server/holdings/above-1.ts`
- `apps/dashboard/src/server/holdings/above-5.ts`
- `apps/dashboard/src/server/holdings/investor-type.ts`
- `apps/dashboard/src/server/holdings/ksei.ts`

Source: apinrdw/kumora#357, apinrdw/kumora#397, apinrdw/kumora#473
