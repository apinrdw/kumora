# Error lines live in chrome.storage.session

The worker's errors used to exist only in the service worker's DevTools console, gone once the worker hung or was reloaded. Its Error and Fatal lines (`error-log.ts`) and the cause "Relay stopped" ended on now live in `chrome.storage.session`. They outlive the service worker and the console, so the owner can still copy them after the relay stopped, yet they are cleared when Chrome closes and never synced.

The Ajaib walks' stall records (the last 50, `brokerCodesStalls`) live there too, for the same reason: on 2026-11-27 the tape walk's second pass paused for 2.5 minutes, and the stall cause the Broker codes card showed was gone by the time anyone asked. A record holds the walk, the day, the page and the failure kinds, never a token, a header or a path.

Sites:

- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#274
