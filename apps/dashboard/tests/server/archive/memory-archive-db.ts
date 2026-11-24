// The archives' metadata for tests: a memory D1 (../memory-d1.ts) with
// archive-migrations/ applied, behind the ArchiveDb service the code uses.
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

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

// `db`, whose first insert of one report's row fails after running, as a
// D1 down for a moment. The failure moves the test clock a minute on, as a
// Workflow's retry of the step runs later than the attempt it retries.
// `failed` says whether it has failed yet.
export const failingFirstReportInsert = (db: MemoryArchiveDb) => {
  let failed = false
  db.failBatch = (sql) => {
    const insert =
      sql.length === 1 && sql.some((each) => each.includes("INSERT"))
    if (!insert || failed) return false
    failed = true
    return true
  }
  return {
    layer: Layer.effect(
      ArchiveDb,
      Effect.gen(function* () {
        const inner = yield* ArchiveDb
        return ArchiveDb.of({
          batch: (statements) =>
            inner
              .batch(statements)
              .pipe(Effect.tapError(() => TestClock.adjust("1 minute"))),
        })
      })
    ).pipe(Layer.provide(db.layer)),
    failed: () => failed,
  }
}
