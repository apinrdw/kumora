// The HoldingsDb a heap test's worker thread reads its memory D1 through
// (derive-worker.ts, daily-holders-worker.ts).
import { Effect } from "effect"

import type { HoldingsDb } from "../../../src/server/holdings/db.ts"
import type { MemoryD1 } from "../memory-d1.ts"

export const workerHoldingsDb = (db: MemoryD1): HoldingsDb["Service"] => ({
  // The memory D1 keeps every statement it ran; D1 doesn't.
  batch: (statements) =>
    db.batch(statements).pipe(
      Effect.map(({ rows }) => rows),
      Effect.tap(() =>
        Effect.sync(() => {
          db.statements.length = 0
        })
      ),
      Effect.orDie
    ),
})
