# Tests, not files, are the unit of parallelism

Playwright runs e2e tests, not files, in parallel, so one file's tests can run on different workers. A file whose tests form a sequence says so with a serial describe.

Sites:
- `apps/e2e/playwright.config.ts`

Source: apinrdw/kumora#168
