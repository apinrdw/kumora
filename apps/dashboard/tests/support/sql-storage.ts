import { DatabaseSync } from "node:sqlite"
import type { SQLInputValue } from "node:sqlite"

/** BLOBs are `ArrayBuffer`s both ways, as in workerd. `node:sqlite` has `Uint8Array`s. */
const toWorkerdRow = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      value instanceof Uint8Array ? new Uint8Array(value).buffer : value,
    ])
  )

/** The part of a Durable Object's `SqlStorage` the relay's store calls, over real SQLite. */
export const sqlStorage = (): SqlStorage => {
  const db = new DatabaseSync(":memory:")
  return {
    exec: (query: string, ...params: Array<SQLInputValue | ArrayBuffer>) => {
      const rows = db
        .prepare(query)
        .all(
          ...params.map((p) =>
            p instanceof ArrayBuffer ? new Uint8Array(p) : p
          )
        )
        .map((row) => toWorkerdRow(row as Record<string, unknown>))
      return { toArray: () => rows, [Symbol.iterator]: () => rows.values() }
    },
  } as unknown as SqlStorage
}
