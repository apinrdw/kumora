// The sector cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. The bridge's runner logs a failure and
// settles, as for the archive crons (../shareholding/cron.ts).
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { holdingsDbD1 } from "../holdings/db.ts"
import { syncSectors } from "./sync.ts"

// Decision: a Promise for Cloudflare's `scheduled`, for the reason
// runArchiveCron gives (../shareholding/cron.ts).
export const runSectorCron = (scheduledTime: number) =>
  runServerEffectResult(
    syncSectors(new Date(scheduledTime)).pipe(
      Effect.asVoid,
      Effect.provide(Layer.merge(holdingsDbD1, FetchHttpClient.layer))
    )
  )
