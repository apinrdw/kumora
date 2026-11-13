# extension

Planting defects in the relay extension's service worker.

- **Run one suite from `apps/extension`.** `pnpm exec vitest run tests/<file>.test.ts`; the type-level fixes (`PacedTab`, `LocalRequest`) plant against `pnpm exec tsc --noEmit -p apps/extension` from the root.
- **The pacer wakes on a queue, not a sleep.** Under `TestClock`, call `TestClock.adjust("0 millis")` after forking a caller, or the call never starts and the test times out instead of failing on its assertion.
- **A fix can be covered outside its own module's test.** Production's status cursor (`production-target.ts`) is covered by `tests/broker-codes/stockbit-walk.test.ts`, which builds a real `makeProductionTarget`; `production-target.test.ts` passes with the cursor dropped.
- **`service-worker.ts` wiring has no unit test.** Removing `stoppedUntil` from a `makePacer` call passes tsc and every suite; only the pacer's own behaviour is tested.
