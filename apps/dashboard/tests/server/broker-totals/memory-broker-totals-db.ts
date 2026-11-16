// The broker totals DB for tests: a memory D1 (../memory-d1.ts) with
// broker-totals-migrations/ applied, behind the BrokerTotalsDb service the
// code uses.
import { Effect, Layer } from "effect"

import { BrokerTotalsDb, BrokerTotalsDbError } from "@/server/broker-totals/db"

import { memoryD1, type MemoryD1 } from "../memory-d1.ts"

const MIGRATIONS = import.meta.glob<string>(
  "../../../broker-totals-migrations/*.sql",
  { query: "?raw", import: "default", eager: true }
)

interface MemoryBrokerTotalsDb extends MemoryD1 {
  readonly layer: Layer.Layer<BrokerTotalsDb>
}

export const memoryBrokerTotalsDb = (): MemoryBrokerTotalsDb => {
  const db = memoryD1(MIGRATIONS)
  return Object.assign(db, {
    layer: Layer.succeed(
      BrokerTotalsDb,
      BrokerTotalsDb.of({
        batch: (statements) =>
          db
            .batch(statements)
            .pipe(
              Effect.mapError((cause) => new BrokerTotalsDbError({ cause }))
            ),
      })
    ),
  })
}
