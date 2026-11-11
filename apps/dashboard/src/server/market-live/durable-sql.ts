// A Durable Object's SQLite database as the day store's `Sql` (day-store.ts):
// Cloudflare hands blobs as ArrayBuffer, the store as Uint8Array.
import type { Sql, SqlValue } from "./day-store.ts"

const bindingOf = (value: SqlValue) =>
  value instanceof Uint8Array ? value.slice().buffer : value

const valueOf = (value: SqlStorageValue): SqlValue =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : value

export const durableSql = (storage: DurableObjectStorage): Sql => ({
  exec: (query, ...bindings) =>
    storage.sql
      .exec(query, ...bindings.map(bindingOf))
      .toArray()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, valueOf(value)])
        )
      ),
  transaction: (write) => storage.transactionSync(write),
})
