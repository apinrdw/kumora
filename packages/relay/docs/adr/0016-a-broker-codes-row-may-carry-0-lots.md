# A broker codes row may carry 0 lots

Ajaib's tape cuts a negotiated-board trade's fractional lots to 0 (CTRA, trade 1559660 on 2026-11-16, NG), and a walk that dropped the row would drop its broker codes too. So a broker codes row may carry 0 lots, and the walk keeps it. Broker totals and candles count the regular board only, so the 0 never reaches a figure.

Sites:
- `packages/relay/src/broker-codes.ts`

Source: apinrdw/kumora#448
