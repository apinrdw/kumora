// The sector cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. The bridge's runner logs a failure and
// settles, as for the archive crons (../shareholding/cron.ts).
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { holdingsDbD1 } from "../holdings/db.ts"
import { recordedSectorRun } from "./sync.ts"

// Decision: a cron runner returns a Promise, standing in for scheduled
// (apps/dashboard/docs/adr/0008-cron-runners-return-a-promise-for-scheduled.md)
export const runSectorCron = (scheduledTime: number) =>
  runServerEffectResult(
    recordedSectorRun(new Date(scheduledTime)).pipe(
      Effect.asVoid,
      Effect.provide(Layer.merge(holdingsDbD1, FetchHttpClient.layer))
    )
  )
