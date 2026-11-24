// Where `alchemy dev` keeps the Test stage's local D1 databases, for the
// reset before a run (reset-test-stage.ts) and the specs that seed one.
import { TEST, stackName } from "@workspace/deploy"
import * as Effect from "effect/Effect"
import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

export const ALCHEMY = new URL("../../dashboard/.alchemy/", import.meta.url)
export const STATE = new URL(
  `state/${Effect.runSync(stackName("dashboard"))}/${TEST}/`,
  ALCHEMY
)

// A database's id, from the Test stage's state. The file is named by the D1
// resource's id in apps/dashboard/alchemy.run.ts.
export function databaseId(resource: string): string | undefined {
  try {
    const state = JSON.parse(
      readFileSync(new URL(`${resource}.json`, STATE), "utf8")
    ) as { attr?: { databaseId?: unknown } }
    const id = state.attr?.databaseId
    return typeof id === "string" ? id : undefined
  } catch {
    return undefined
  }
}

// Alchemy keeps each local D1 in a Durable Object named by the database id,
// so its file is workerd's idFromName: an HMAC-SHA256 keyed by the hash of
// the namespace's unique key (repos/alchemy, cloudflare-runtime D1.ts and
// D1.worker.ts).
export function databaseFile(id: string) {
  const key = createHash("sha256")
    .update("cloudflare-runtime-D1DatabaseObject")
    .digest()
  const head = createHmac("sha256", key).update(id).digest().subarray(0, 16)
  const tail = createHmac("sha256", key).update(head).digest().subarray(0, 16)
  const name = Buffer.concat([head, tail]).toString("hex")
  return new URL(
    `local/d1/cloudflare-runtime-D1DatabaseObject/${name}.sqlite`,
    ALCHEMY
  )
}

// Runs `fill` on the Test stage's D1 `resource`, in one transaction.
export function writeTo(resource: string, fill: (db: DatabaseSync) => void) {
  const id = databaseId(resource)
  if (id === undefined) throw new Error(`The Test stage has no ${resource} yet`)
  // The dashboard holds the file open too: wait out its locks.
  const db = new DatabaseSync(databaseFile(id).pathname, { timeout: 5000 })
  try {
    db.exec("BEGIN")
    fill(db)
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

// Empties `tables` of the Test stage's D1 `resource`, then runs `fill`, in
// one transaction.
export function replaceTables(
  resource: string,
  tables: ReadonlyArray<string>,
  fill: (db: DatabaseSync) => void
) {
  writeTo(resource, (db) => {
    for (const table of tables) db.exec(`DELETE FROM ${table}`)
    fill(db)
  })
}
