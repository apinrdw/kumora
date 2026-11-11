// A Durable Object's SQLite database as the day store's `Sql` (day-store.ts):
// Cloudflare hands blobs as ArrayBuffer, the store as Uint8Array.
import { Effect } from "effect"

import type { Sql, SqlValue } from "./day-store.ts"

export const durableSql = (storage: DurableObjectStorage) =>
  Effect.succeed<Sql>({
    exec: (query, ...bindings) =>
      storage.sql
        .exec(
          query,
          ...bindings.map((value) =>
            value instanceof Uint8Array ? value.slice().buffer : value
          )
        )
        .toArray()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]): [string, SqlValue] => [
              key,
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ])
          )
        ),
    transaction: (write) => storage.transactionSync(write),
  })
