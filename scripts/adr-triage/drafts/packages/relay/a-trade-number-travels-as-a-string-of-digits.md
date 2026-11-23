# A trade number travels as a string of digits

A trade number travels as a string of digits, not a JSON number. The date-prefixed form, YYYYMMDD plus the sequence, exceeds 2^53, so a JSON number would lose digits.

Sites:
- `packages/relay/src/envelope.ts`

Source: apinrdw/kumora#45
