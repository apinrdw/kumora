# A test-only clock offset moves the relay's schedule

The extension e2e must run in streaming hours, and walk a closed day, at any hour. A test-only clock offset, in ms, moves the relay's schedule clock: streaming hours, auctions, the code list's day, and the walks' Streaming hours, newest closed day and Ajaib's window. Frames keep their real receive times and tape queries keep the real time. Only a script in the worker's console sets the offset, never the options page. A changed offset ticks the relay at once, and a completed tick leaves its offset in the worker's global scope, so a spec that moves the clock awaits a tick on the new clock instead of sleeping. With the key never set, as in the owner's browser, the relay ticks only on its timer and the walks read the real clock.

Sites:
- `apps/extension/src/worker/settings.ts`
- `apps/extension/src/worker/service-worker.ts`
- `apps/extension/src/worker/broker-codes/hours.ts`

Source: apinrdw/kumora#155, apinrdw/kumora#174, apinrdw/kumora#273
