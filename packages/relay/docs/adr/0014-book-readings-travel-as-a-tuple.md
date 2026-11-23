# Book readings travel as a tuple

Every changed code's book readings go out in each delta, and the spec budgets about 100 bytes for one code's readings. Keys would double that, so readings travel as a tuple, not a keyed object.

Sites:
- `packages/relay/src/book-readings.ts`

Source: apinrdw/kumora#517
