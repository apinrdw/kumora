# Matched trades post after the last code, in trade order

The Done Details walk holds its matched trades until the last code is walked, then posts them in trade order, `BATCH_ROWS` a batch. Each batch then spans a minute or two of the day, so the dashboard's sweep brokers recompute regroups each market minute about once, not once per code. Coalescing on the dashboard instead was rejected: it would write rows after a batch's 200 answer.

Sites:
- `apps/extension/src/worker/broker-codes/done-details-walk.ts`

Source: apinrdw/kumora#632
