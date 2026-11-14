// The KSEI archive cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. It returns a Promise for the reason the shareholding
// archive's (../shareholding/cron.ts) does.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import { kseiBucketR2, kseiWorkflowBinding } from "./bindings.ts"
import { scheduledKseiRun } from "./runs.ts"

export const runKseiCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledKseiRun(scheduledTime).pipe(
      Effect.provide(Layer.merge(kseiBucketR2, kseiWorkflowBinding))
    )
  )
