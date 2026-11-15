// Runs before the apps start (playwright.config.ts). Each e2e run starts with
// empty local D1s (the auth and parsed holdings databases): without the Test stage's Alchemy state, `alchemy dev`
// creates a new local database (and signing secret) and applies the
// migrations to it. It also starts with empty Market Live Durable Objects.
// The Dev stage's state is left alone.
import { TEST, stageTarget } from "@workspace/deploy"
import * as Effect from "effect/Effect"
import { rmSync } from "node:fs"

import { ALCHEMY, STATE, databaseFile, databaseId } from "./support/local-d1.ts"

// Only the previous run's files go; the Dev stage's stay.
for (const resource of ["AuthDb", "HoldingsDb"]) {
  const id = databaseId(resource)
  if (id === undefined) continue
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${databaseFile(id).pathname}${suffix}`, { force: true })
  rmSync(
    new URL(`local/cache/alchemy-d1-gateway-${id.replace(":", "-")}`, ALCHEMY),
    {
      recursive: true,
      force: true,
    }
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
