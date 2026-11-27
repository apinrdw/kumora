# Book alert limits hold across a browser's tabs

Each book alert event alerts once per browser, and its cooldowns and the minute's count hold across the browser's tabs and reloads. They are one localStorage value, admitted against under the Web Lock `kumora:book-alerts:limits` by the alert owner (`use-alert-owner.ts`) only. An event heard twice cools on its own code, kind and time.

Sites:

- `apps/dashboard/src/components/book-alerts/use-book-alerts.ts`

Source: apinrdw/kumora#526
