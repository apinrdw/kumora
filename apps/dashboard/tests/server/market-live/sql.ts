// The trading day's SQLite database for tests: Node's, in memory, behind the
// day store's `Sql` (src/server/market-live/day-store.ts). Handing the same
// database to a second trading day is a restart.
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite"

import { Effect } from "effect"

import type { Sql, SqlValue } from "@/server/market-live/day-store"
import { HOLDS_A_TRADE } from "@/server/market-live/tape"

export const memorySql = (): Sql => {
  const database = new DatabaseSync(":memory:")
  // Each query string is prepared once and reused. Preparing per
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

// Durable Object SQLite refuses a row over 2 MB, where Node's allows
// 1 GB. A test that a day's rows stay under it runs on `rowLimited`.
const DURABLE_ROW_BYTES = 2_000_000

// `sql` refusing a statement that binds a value over Durable Object SQLite's
// row limit, as SQLITE_TOOBIG.
export const rowLimited = (sql: Sql): Sql => ({
  ...sql,
  exec: (query, ...bindings) => {
    for (const value of bindings) {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value).length
          : value instanceof Uint8Array
            ? value.length
            : 0
      // The storage API is synchronous and throws; runSync throws the failure.
      if (bytes > DURABLE_ROW_BYTES)
        return Effect.runSync(
          Effect.fail(new Error(`SQLITE_TOOBIG: ${bytes} bytes`))
        )
    }
    return sql.exec(query, ...bindings)
  },
})

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

// An object opened before trade chunks (spec apinrdw/kumora#555) that never
// held a trade: the row-per-trade `trades` table, made and left empty.
export const openedEmptySql = (): Sql => {
  const sql = memorySql()
  sql.exec(`CREATE TABLE trades (
    number INTEGER PRIMARY KEY,
    time INTEGER NOT NULL,
    code TEXT NOT NULL,
    price REAL NOT NULL,
    lots REAL NOT NULL,
    side TEXT NOT NULL,
    board TEXT NOT NULL,
    feeds TEXT NOT NULL
  )`)
  return sql
}

// A day recorded before trade chunks: its tape is the row-per-trade `trades`
// table. Such a day held a trade before any store of this code started on
// it, so the tape's check for one (HOLDS_A_TRADE) answers that it does, and
// a test writes the day's trades after the store starts.
export const rowShapedSql = (): Sql => {
  const sql = openedEmptySql()
  return {
    ...sql,
    exec: (query, ...bindings) =>
      query === HOLDS_A_TRADE ? [{ 1: 1 }] : sql.exec(query, ...bindings),
  }
}
