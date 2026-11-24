// The KSEI archive cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. It returns a Promise for the reason the shareholding
// archive's (../shareholding/cron.ts) does.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveDbD1 } from "../archive/archive-db.ts"
import {
  kseiBucketR2,
  kseiParseWorkflowBinding,
  kseiWorkflowBinding,
} from "./bindings.ts"
import { kseiParseRuns } from "./parse-runs.ts"
import { scheduledKseiRun } from "./runs.ts"

export const runKseiCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledKseiRun(scheduledTime).pipe(
      Effect.provide(
        Layer.mergeAll(kseiBucketR2, archiveDbD1, kseiWorkflowBinding)
      )
    )
  )

// The KSEI parse cron's handler, the same way.
export const runKseiParseCron = (scheduledTime: number) =>
  runServerEffectResult(
    kseiParseRuns
      .scheduled(scheduledTime)
      .pipe(
        Effect.provide(
          Layer.mergeAll(kseiBucketR2, archiveDbD1, kseiParseWorkflowBinding)
        )
      )
  )
