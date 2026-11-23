# Scanner figures travel as a tuple

A snapshot carries scanner figures for every code with readings, about 900 on a busy day. So a code's figures travel as a tuple, `[code, last, previous close, previous value, value today]`, with none as null, not a keyed object. Both values are rounded to the rupiah.

Sites:
- `packages/relay/src/scanner-figures.ts`

Source: apinrdw/kumora#526
