// The archives' metadata for tests: a memory D1 (../memory-d1.ts) with
// archive-migrations/ applied, behind the ArchiveDb service the code uses.
import { Effect, Layer } from "effect"

import { ArchiveDb, ArchiveDbError } from "@/server/archive/archive-db"

import { memoryD1, type MemoryD1 } from "../memory-d1.ts"

const MIGRATIONS = import.meta.glob<string>(
  "../../../archive-migrations/*.sql",
  { query: "?raw", import: "default", eager: true }
)

export interface MemoryArchiveDb extends MemoryD1 {
  readonly layer: Layer.Layer<ArchiveDb>
}

export const memoryArchiveDb = (): MemoryArchiveDb => {
  const db = memoryD1(MIGRATIONS)
  return Object.assign(db, {
    layer: Layer.succeed(
      ArchiveDb,
      ArchiveDb.of({
        batch: (statements) =>
          db.batch(statements).pipe(
            Effect.map(({ rows }) => rows),
            Effect.mapError((cause) => new ArchiveDbError({ cause }))
          ),
      })
    ),
  })
}
