# The Done Details store keys trades by trade number

Version 4 of the Done Details store keys the tape walk's trades, unkeyed ones too, and the matched trades by trade number as a number, so they read back in trade order and a span of numbers counts in one request. An older database's walk is dropped whole rather than migrated: its trades say nothing of the ones the tape walk read unkeyed, so that day's order numbers come from Stockbit's walk instead.

Sites:
- `apps/extension/src/worker/broker-codes/done-details-store.ts`

Source: apinrdw/kumora#632
