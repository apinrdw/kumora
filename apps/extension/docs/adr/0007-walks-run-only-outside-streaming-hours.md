# Walks run only outside Streaming hours

Broker codes walks run only outside Streaming hours, as `schedule.ts` in `@workspace/relay` defines them, so the live relay keeps the broker tab and the account's calls to itself during the day. A year missing from the schedule reads as outside Streaming hours, as the relay's own window does in `gate.ts`.

Sites:
- `apps/extension/src/worker/broker-codes/hours.ts`

Source: apinrdw/kumora#196
