// Parsed holdings for tests: a memory D1 (../memory-d1.ts) with
// holdings-migrations/ applied, behind the HoldingsDb service the code uses.
import { Effect, Layer } from "effect"

import { HoldingsDb, HoldingsDbError } from "@/server/holdings/db"

import { memoryD1, type MemoryD1 } from "../memory-d1.ts"

const MIGRATIONS = import.meta.glob<string>(
  "../../../holdings-migrations/*.sql",
  { query: "?raw", import: "default", eager: true }
)

export interface MemoryHoldingsDb extends MemoryD1 {
  readonly layer: Layer.Layer<HoldingsDb>
}

export const memoryHoldingsDb = (): MemoryHoldingsDb => {
  const db = memoryD1(MIGRATIONS)
  return Object.assign(db, {
    layer: Layer.succeed(
      HoldingsDb,
      HoldingsDb.of({
        batch: (statements) =>
          db.batch(statements).pipe(
            Effect.map(({ rows }) => rows),
            Effect.mapError((cause) => new HoldingsDbError({ cause }))
          ),
      })
    ),
  })
}
