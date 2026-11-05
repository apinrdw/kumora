import { readdirSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"

import { MAX_BOUND_PARAMETERS } from "@/ownership/store"

const MIGRATIONS = new URL("../../migrations/", import.meta.url)

/**
 * The part of `D1Database` the ownership store calls, over real SQLite with the
 * real migrations. As in D1, foreign keys are on, a batch is one transaction,
 * and a statement refuses more parameters than D1 binds, or an `undefined`.
 * `onRead` hears how many rows each statement returned.
 */
export const d1Database = (
  onRead: (rowCount: number) => void = () => {}
): D1Database => {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const name of readdirSync(MIGRATIONS).sort())
    db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"))

  const statement = (
    query: string,
    values: ReadonlyArray<SQLInputValue> = []
  ) => {
    const read = () => {
      if (values.length > MAX_BOUND_PARAMETERS)
        throw new Error(`D1: ${values.length} bound parameters: ${query}`)
      if (values.includes(undefined as never))
        throw new Error(`D1: undefined bound: ${query}`)
      const rows = db.prepare(query).all(...values) as Array<
        Record<string, unknown>
      >
      onRead(rows.length)
      return rows
    }
    const result = async () => ({ success: true, results: read() })
    return {
      read,
      bind: (...next: Array<SQLInputValue>) => statement(query, next),
      first: async () => read()[0] ?? null,
      all: result,
      run: result,
    }
  }

  return {
    prepare: (query: string) => statement(query),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      db.exec("BEGIN")
      try {
        const results = statements.map((s) => ({
          success: true,
          results: s.read(),
        }))
        db.exec("COMMIT")
        return results
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  } as unknown as D1Database
}
