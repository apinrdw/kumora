// Runs before the apps start (playwright.config.ts). Each e2e run starts with
// empty local D1s (the auth and parsed holdings databases): without the Test stage's Alchemy state, `alchemy dev`
// creates a new local database (and signing secret) and applies the
// migrations to it. It also starts with empty Market Live Durable Objects.
// The Dev stage's state is left alone.
import { TEST, stackName, stageTarget } from "@workspace/deploy"
import * as Effect from "effect/Effect"
import { createHash, createHmac } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"

const ALCHEMY = new URL("../dashboard/.alchemy/", import.meta.url)
const STATE = new URL(
  `state/${Effect.runSync(stackName("dashboard"))}/${TEST}/`,
  ALCHEMY
)

// The previous run's id of a database, from the state about to be deleted.
// The file is named by the D1 resource's id in apps/dashboard/alchemy.run.ts.
function previousDatabaseId(resource: string): string | undefined {
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

for (const resource of ["AuthDb", "HoldingsDb"]) {
  const databaseId = previousDatabaseId(resource)
  if (databaseId === undefined) continue
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

// The trading-day and index objects keep their SQLite stores across
// `alchemy dev` restarts, so a run would start from the last run's tape and
// candles. `alchemy dev` keeps a class's objects in `local/<worker>-<class>/`;
// the class names are the Durable Object bindings' in
// apps/dashboard/alchemy.run.ts.
const { workerName } = Effect.runSync(stageTarget("dashboard", TEST))
for (const className of ["TradingDay", "DayIndex"])
  rmSync(new URL(`local/${workerName}-${className}/`, ALCHEMY), {
    recursive: true,
    force: true,
  })
