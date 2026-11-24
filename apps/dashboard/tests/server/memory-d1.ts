// A D1 database for tests: Node's SQLite, in memory, with `migrations`
// applied in name order. A batch runs in one transaction, as D1's does, and
// counts the rows it changed as its rows written. `failBatch`, when set,
// fails every batch it matches after running its statements, so the batch
// rolls back as a D1 batch whose last statement failed. `statements` holds
// every statement a batch was given, in order.
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite"

import { Effect } from "effect"

import type { D1Batch, Statement } from "@/server/d1"

export interface MemoryD1 {
  readonly database: DatabaseSync
  failBatch: ((sql: ReadonlyArray<string>) => boolean) | undefined
  readonly statements: Array<Statement>
  readonly batch: (
    statements: ReadonlyArray<Statement>
  ) => Effect.Effect<D1Batch, unknown>
}

export const memoryD1 = (migrations: Record<string, string>): MemoryD1 => {
  const database = new DatabaseSync(":memory:")
  for (const [, sql] of Object.entries(migrations).sort(([a], [b]) =>
    a < b ? -1 : 1
  ))
    database.exec(sql)
  const prepared = new Map<string, StatementSync>()
  const statement = (sql: string) => {
    const cached = prepared.get(sql)
    if (cached !== undefined) return cached
    const made = database.prepare(sql)
    prepared.set(sql, made)
    return made
  }
  const changes = () =>
    Number(
      (
        statement("SELECT total_changes() AS changes").get() as {
          changes: number
        }
      ).changes
    )
  const db: MemoryD1 = {
    database,
    failBatch: undefined,
    statements: [],
    // One synchronous step, so no other fiber's batch runs inside it, as
    // D1 runs each batch whole. A batch `failBatch` matches ends undefined,
    // rolled back.
    batch: (batch) =>
      Effect.try((): D1Batch | undefined => {
        db.statements.push(...batch)
        const before = changes()
        database.exec("BEGIN")
        try {
          const rows = batch.map(({ sql, params }) =>
            statement(sql).all(...(params as Array<SQLInputValue>))
          )
          if (db.failBatch?.(batch.map(({ sql }) => sql)) === true)
            return undefined
          const rowsWritten = changes() - before
          database.exec("COMMIT")
          return { rows, rowsWritten }
        } finally {
          if (database.isTransaction) database.exec("ROLLBACK")
        }
      }).pipe(
        Effect.flatMap((result) =>
          result === undefined
            ? Effect.fail(new Error("D1 is unavailable"))
            : Effect.succeed(result)
        )
      ),
  }
  return db
}
