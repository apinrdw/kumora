// The Special Monitoring Board cron's handler, which runCron (../crons.ts)
// calls for the Worker entry's `scheduled`. The bridge's runner logs a
// failure, IDX's included, and settles, as for the sector cron.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { holdingsDbD1 } from "../holdings/db.ts"
import { syncSpecialBoard } from "./sync.ts"

// Decision: a Promise for Cloudflare's `scheduled`, for the reason
// runArchiveCron gives (../shareholding/cron.ts).
export const runSpecialBoardCron = (scheduledTime: number) =>
  runServerEffectResult(
    syncSpecialBoard(new Date(scheduledTime)).pipe(
      Effect.asVoid,
      Effect.provide(Layer.merge(holdingsDbD1, FetchHttpClient.layer))
    )
  )
