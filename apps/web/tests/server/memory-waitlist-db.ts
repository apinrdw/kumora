// The waitlist DB for tests: Node's SQLite, in memory, with
// waitlist-migrations/ applied in name order, behind the WaitlistDb service
// the code uses. A batch runs in one transaction, as D1's does, and in one
// synchronous step, so no other fiber's batch runs inside it.
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import { Effect, Layer } from "effect"

import { WaitlistDb, WaitlistDbError } from "@/server/waitlist/db"

const MIGRATIONS = import.meta.glob<string>("../../waitlist-migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
})

export const memoryWaitlistDb = () => {
  const database = new DatabaseSync(":memory:")
  for (const [, sql] of Object.entries(MIGRATIONS).sort(([a], [b]) =>
    a < b ? -1 : 1
  ))
    database.exec(sql)
  return {
    database,
    layer: Layer.succeed(
      WaitlistDb,
      WaitlistDb.of({
        batch: (statements) =>
          Effect.try({
            try: () => {
              database.exec("BEGIN")
              try {
                const rows = statements.map(({ sql, params }) =>
                  database.prepare(sql).all(...(params as Array<SQLInputValue>))
                )
                database.exec("COMMIT")
                return rows
              } finally {
                if (database.isTransaction) database.exec("ROLLBACK")
              }
            },
            catch: (cause) => new WaitlistDbError({ cause }),
          }),
      })
    ),
  }
}
