# The three indices travel as stock codes

The three indices travel as stock codes in every viewer message, rather than as a separate kind. Stockbit names them in the same `liveprice` symbol field, and the trading-day object tells an index by the frame's `is_index`. The relay subscribes them explicitly, since Ajaib's code list has none.

Sites:

- `packages/relay/src/codes.ts`

Source: apinrdw/kumora#138
