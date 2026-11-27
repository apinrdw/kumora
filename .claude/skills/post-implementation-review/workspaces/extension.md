# extension

Planting defects in the relay extension's service worker.

- **Run one suite from `apps/extension`.** `vp exec vitest run tests/<file>.test.ts`; the type-level fixes (`PacedTab`, `LocalRequest`) plant against `vp lint apps/extension` from the root, which type-checks with tsrs.
- **The pacer wakes on a queue, not a sleep.** Under `TestClock`, call `TestClock.adjust("0 millis")` after forking a caller, or the call never starts and the test times out instead of failing on its assertion.
- **A fix can be covered outside its own module's test.** Production's status cursor (`production-target.ts`) is covered by `tests/broker-codes/stockbit-walk.test.ts`, which builds a real `makeProductionTarget`; `production-target.test.ts` passes with the cursor dropped.
- **`service-worker.ts` wiring has no unit test.** Removing `stoppedUntil` from a `makePacer` call passes the type check and every suite; only the pacer's own behaviour is tested.
- **The Done Details store has an IndexedDB test.** `tests/broker-codes/done-details-store.test.ts` stubs `indexedDB` with `fake-indexeddb` (an extension devDependency) and opens the real store; the walk tests use `memoryStore` and never reach `openDatabase`, so an upgrade-path fix plants against the store test.
