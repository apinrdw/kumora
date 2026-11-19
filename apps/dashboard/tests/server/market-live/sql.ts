// The trading day's SQLite database for tests: Node's, in memory, behind the
// day store's `Sql` (src/server/market-live/day-store.ts). Handing the same
// database to a second trading day is a restart.
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite"

import type { Sql, SqlValue } from "@/server/market-live/day-store"

export const memorySql = (): Sql => {
  const database = new DatabaseSync(":memory:")
  // Decision: each query string is prepared once and reused. Preparing per
  // call dominated the candles and recorded-day tests (#171).
  const statements = new Map<string, StatementSync>()
  const statement = (query: string) => {
    const cached = statements.get(query)
    if (cached !== undefined) return cached
    const prepared = database.prepare(query)
    statements.set(query, prepared)
    return prepared
  }
  return {
    exec: (query, ...bindings) =>
      statement(query).all(...(bindings as Array<SQLInputValue>)) as Array<
        Record<string, SqlValue>
      >,
    // A write that fails rolls back, as the Durable Object's
    // `transactionSync` does.
    transaction: (write) => {
      database.exec("BEGIN")
      try {
        write()
        database.exec("COMMIT")
      } finally {
        if (database.isTransaction) database.exec("ROLLBACK")
      }
    },
  }
}

// `sql` counting as Cloudflare's does: every row a statement returned as
// read, and every write statement as one row written.
export const counted = (sql: Sql): Sql => {
  const usage = { rowsRead: 0, rowsWritten: 0, bytes: 0 }
  return {
    ...sql,
    exec: (query, ...bindings) => {
      const rows = sql.exec(query, ...bindings)
      usage.rowsRead += rows.length
      if (/^\s*(INSERT|DELETE|UPDATE|REPLACE)/i.test(query))
        usage.rowsWritten += 1
      return rows
    },
    usage: () => ({ ...usage }),
  }
}
