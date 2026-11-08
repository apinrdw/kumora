// Runs before the apps start (playwright.config.ts). Each e2e run starts with
// an empty local D1: without the Test stage's Alchemy state, `alchemy dev`
// creates a new local database (and signing secret) and applies the
// migrations to it. The Dev stage's state is left alone.
import { TEST, stackName } from "@workspace/deploy"
import * as Effect from "effect/Effect"
import { createHash, createHmac } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"

const ALCHEMY = new URL("../dashboard/.alchemy/", import.meta.url)
const STATE = new URL(
  `state/${Effect.runSync(stackName("dashboard"))}/${TEST}/`,
  ALCHEMY
)

// The previous run's database id, from the state about to be deleted. The
// file is named by the D1 resource's id in apps/dashboard/alchemy.run.ts.
function previousDatabaseId(): string | undefined {
  try {
    const state = JSON.parse(
      readFileSync(new URL("AuthDb.json", STATE), "utf8")
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
// D1.worker.ts). Only the previous run's file goes; the Dev stage's stay.
function durableObjectFile(databaseId: string) {
  const key = createHash("sha256")
    .update("cloudflare-runtime-D1DatabaseObject")
    .digest()
  const head = createHmac("sha256", key)
    .update(databaseId)
    .digest()
    .subarray(0, 16)
  const tail = createHmac("sha256", key).update(head).digest().subarray(0, 16)
  return Buffer.concat([head, tail]).toString("hex")
}

const databaseId = previousDatabaseId()
if (databaseId !== undefined) {
  const file = durableObjectFile(databaseId)
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(
      new URL(
        `local/d1/cloudflare-runtime-D1DatabaseObject/${file}.sqlite${suffix}`,
        ALCHEMY
      ),
      { force: true }
    )
  rmSync(
    new URL(
      `local/cache/alchemy-d1-gateway-${databaseId.replace(":", "-")}`,
      ALCHEMY
    ),
    { recursive: true, force: true }
  )
}
rmSync(STATE, { recursive: true, force: true })
