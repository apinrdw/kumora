# Pages ask the worker through a session storage key

A page that asks the service worker to act, such as the options page's code list relay button or "Run now", writes `asked` to a session storage key, as the settings do. The storage change wakes a stopped worker, and the worker writes its outcome back under the same key: "Run now" answers `started` once it has triggered the run queue, so the next press is a change again.

Sites:

- `apps/extension/src/worker/settings.ts`

Source: apinrdw/kumora#244
