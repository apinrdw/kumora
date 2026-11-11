// The trading day's SQLite database for tests: Node's, in memory, behind the
// day store's `Sql` (src/server/market-live/day-store.ts). Handing the same
// database to a second trading day is a restart.
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import type { Sql, SqlValue } from "@/server/market-live/day-store"

export const memorySql = (): Sql => {
  const database = new DatabaseSync(":memory:")
  return {
    exec: (query, ...bindings) =>
      database
        .prepare(query)
        .all(...(bindings as Array<SQLInputValue>)) as Array<
        Record<string, SqlValue>
      >,
    transaction: (write) => {
      database.exec("BEGIN")
      write()
      database.exec("COMMIT")
    },
  }
}
