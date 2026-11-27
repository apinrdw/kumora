# Broker codes refusals: 401 refuses the token, 426 means reload

The extension POSTs broker codes to Production and to an optional extra target, and must tell a refusal it can't fix by retrying from a passing failure. A 401 refuses the token. A 426, or a status read's 200 whose body isn't this version's status, means the dashboard moved on and the extension must be reloaded; it shows `reload-extension`. Either stops that target until its origin, token or settings change, and nothing is sent to it meanwhile. Production's Target state shows the refusal over the socket's, since the socket can stay connected while the dashboard refuses broker codes. Any other failure is resent with the ingest backoff, 1 s doubling to 30 s, which is safe because the trading-day object writes a resent batch idempotently.

The broker codes protocol version is what produces the 426, and each bump gives older extensions one: 2 when the status started listing at most `MISSING_RANGES` ranges, 3 when rows carried trade fields (#425), 4 when they carried time and side, which a walk day takes as its tape, after 0.0.29 sent 3 without them (#437), and 5 when a row may carry order numbers and the status counts them (#627).

Sites:

- `apps/extension/src/worker/broker-codes/status.ts`
- `apps/extension/src/worker/broker-codes/extra-target.ts`
- `apps/extension/src/worker/broker-codes/production-target.ts`
- `apps/extension/src/worker/broker-codes/poster.ts`
- `packages/relay/src/broker-codes.ts`

Source: apinrdw/kumora#193, apinrdw/kumora#244, apinrdw/kumora#425, apinrdw/kumora#437, apinrdw/kumora#627
