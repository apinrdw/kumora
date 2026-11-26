# The tape is the one module that runs SQL on a trades table

In `apps/dashboard`, the tape is the one module that runs SQL against a trading day's `trades` table; lint rejects that SQL anywhere else. So a second backing for the trades, such as trade chunks, lands in the tape alone. Tests that record a day before trade chunks still write the table directly.

Sites:

- `vite.config.ts`

Source: apinrdw/kumora#555, apinrdw/kumora#567
