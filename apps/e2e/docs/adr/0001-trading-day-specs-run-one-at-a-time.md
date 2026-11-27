# Trading-day specs run one at a time

The specs that send trades share one Durable Object, today's trading day, so a spec running alongside would add trades to the tape another counts. A run has one server and one storage, and the dashboard has no test-only key for a trading day, so these specs run one at a time.

Sites:

- `apps/e2e/playwright.config.ts`

Source: apinrdw/kumora#157, apinrdw/kumora#169
