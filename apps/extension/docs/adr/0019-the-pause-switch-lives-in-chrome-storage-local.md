# The Pause switch lives in chrome.storage.local

The owner's Pause switch lives in `chrome.storage.local`, so a pause holds across restarts of the worker and of Chrome. It stops every broker codes walk; the live relay and Market Live's backfill go on.

Sites:

- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#244
