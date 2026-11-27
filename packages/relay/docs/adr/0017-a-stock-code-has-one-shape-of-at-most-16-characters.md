# A stock code has one shape of at most 16 characters

A stock code is capitals, digits and dashes (`BBCA`, `BUMI-W2`), optionally after a two-letter board and a dot (`TN.IHSG`), at most 16 characters; the longest listed is 10. Every decoder shares this one shape, and the trading-day object's storage, the watchlist cap and the holdings parsers count on the length.

Sites:

- `packages/relay/src/codes.ts`

Source: apinrdw/kumora#157
