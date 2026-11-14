// A Durable Object's SQLite database as the day store's `Sql` (day-store.ts):
// Cloudflare hands blobs as ArrayBuffer, the store as Uint8Array. It keeps
// the rows each statement's cursor says it read and wrote, the figures
// Cloudflare bills.
import { Effect } from "effect"

import type { Sql, SqlValue } from "./day-store.ts"

export const durableSql = (storage: DurableObjectStorage) =>
  Effect.sync((): Sql => {
    let rowsRead = 0
    let rowsWritten = 0
    return {
      exec: (query, ...bindings) => {
        const cursor = storage.sql.exec(
          query,
          ...bindings.map((value) =>
            value instanceof Uint8Array ? value.slice().buffer : value
          )
        )
        const rows = cursor.toArray()
        rowsRead += cursor.rowsRead
        rowsWritten += cursor.rowsWritten
        return rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]): [string, SqlValue] => [
              key,
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ])
          )
        )
      },
      transaction: (write) => storage.transactionSync(write),
      usage: () => ({
        rowsRead,
        rowsWritten,
        bytes: storage.sql.databaseSize,
      }),
    }
  })
