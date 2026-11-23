# The service worker ticks every 10 s, woken by an alarm

The relay's heartbeat is the service worker's 10 s tick; in-tab timers are throttled in background tabs and never relied on. Chrome stops an idle worker, so a `chrome.alarms` alarm at 30 s, its shortest period, wakes it, and ticks only when the in-worker timer is overdue.

Sites:
- `apps/extension/src/worker/service-worker.ts`

Source: apinrdw/kumora#59
