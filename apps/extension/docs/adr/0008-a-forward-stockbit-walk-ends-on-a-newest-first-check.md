# A forward Stockbit walk ends on a newest-first check

Stockbit's walk reads the tape forward from trade 1, so an empty page alone doesn't prove the tape has ended. A forward walk that reaches an empty page ends only once one newest-first call shows no trade past it, and then posts `end` with the highest trade number it saw. A tape that grew past the walk is walked on.

Sites:

- `apps/extension/src/worker/broker-codes/stockbit-walk.ts`

Source: apinrdw/kumora#244
