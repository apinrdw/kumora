# The day flushes to the day store once a minute

The day's state is written to the day store once a minute, 5 s past it, so each flush closes the minute's book chunks and 5 s merge windows. Only the relay going offline (`ingestClosed`) flushes at once. A failed flush's payload rides the next, so a candle is never stored without its trades.

Sites:

- `packages/relay/src/recorded-day.ts`

Source: apinrdw/kumora#138, apinrdw/kumora#157
