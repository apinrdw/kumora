// The parsed holdings database for tests: Node's SQLite, in memory, with
// holdings-migrations/ applied in order, behind the HoldingsDb service the
// code uses. A batch runs in one transaction, as D1's does. `failBatch`, when
// set, fails every batch it matches after running its statements, so the
// batch rolls back as a D1 batch whose last statement failed.
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite"

import { Effect, Layer } from "effect"

import { HoldingsDb, HoldingsDbError } from "@/server/holdings/db"

const MIGRATIONS = import.meta.glob<string>(
  "../../../holdings-migrations/*.sql",
  { query: "?raw", import: "default", eager: true }
)

export interface MemoryHoldingsDb {
  readonly database: DatabaseSync
  failBatch: ((sql: ReadonlyArray<string>) => boolean) | undefined
  readonly layer: Layer.Layer<HoldingsDb>
}

export const memoryHoldingsDb = (): MemoryHoldingsDb => {
  const database = new DatabaseSync(":memory:")
  for (const [, sql] of Object.entries(MIGRATIONS).sort(([a], [b]) =>
    a < b ? -1 : 1
  ))
    database.exec(sql)
  const statements = new Map<string, StatementSync>()
  const statement = (sql: string) => {
    const cached = statements.get(sql)
    if (cached !== undefined) return cached
    const prepared = database.prepare(sql)
    statements.set(sql, prepared)
    return prepared
  }
  const db: MemoryHoldingsDb = {
    database,
    failBatch: undefined,
    layer: Layer.succeed(
      HoldingsDb,
      HoldingsDb.of({
        batch: (batch) =>
          Effect.try({
            try: () => {
              database.exec("BEGIN")
              return batch.map(({ sql, params }) =>
                statement(sql).all(...(params as Array<SQLInputValue>))
              )
            },
            catch: (cause) => new HoldingsDbError({ cause }),
          }).pipe(
            Effect.flatMap((results) =>
              db.failBatch?.(batch.map(({ sql }) => sql)) === true
                ? Effect.fail(
                    new HoldingsDbError({
                      cause: new Error("D1 is unavailable"),
                    })
                  )
                : Effect.sync(() => {
                    database.exec("COMMIT")
                    return results
                  })
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (database.isTransaction) database.exec("ROLLBACK")
              })
            )
          ),
      })
    ),
  }
  return db
}
