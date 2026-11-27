# Error lines live in chrome.storage.session

The worker's errors used to exist only in the service worker's DevTools console, gone once the worker hung or was reloaded. Its Error and Fatal lines (`error-log.ts`) and the cause "Relay stopped" ended on now live in `chrome.storage.session`. They outlive the service worker and the console, so the owner can still copy them after the relay stopped, yet they are cleared when Chrome closes and never synced.

Sites:

- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#274
