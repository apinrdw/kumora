# Indicative prices are served only during their auction

A code's indicative price is served only while the auction of its time runs, judged by the server's clock for every viewer. The prices are held all day, so without this the morning's price would come back at 15:50. The page applies the same rule (`market-conditions.tsx`). Ajaib's indicative price is served only while Stockbit isn't live.

Sites:
- `apps/dashboard/src/server/market-live/market-conditions.ts`

Source: apinrdw/kumora#157
