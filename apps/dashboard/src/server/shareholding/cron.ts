// The archive cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. The bridge's runner logs a failure, as it does
// for every other callback, and settles instead of rejecting.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveDbD1 } from "../archive/archive-db.ts"
import {
  above1ParseWorkflowBinding,
  archiveBucketR2,
  archiveWorkflowBinding,
  classificationParseWorkflowBinding,
  investorTypeParseWorkflowBinding,
} from "./bindings.ts"
import { scheduledParseRuns } from "./parse-runs.ts"
import { scheduledArchiveRun } from "./runs.ts"

// Decision: a cron runner returns a Promise, standing in for scheduled
// (apps/dashboard/docs/adr/0008-cron-runners-return-a-promise-for-scheduled.md)
export const runArchiveCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledArchiveRun(scheduledTime).pipe(
      Effect.provide(
        Layer.mergeAll(archiveBucketR2, archiveDbD1, archiveWorkflowBinding)
      )
    )
  )

// The parse cron's handler, the same way: it starts a parse run of each kind
// (parse-runs.ts).
export const runParseCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledParseRuns(scheduledTime).pipe(
      Effect.provide(
        Layer.mergeAll(
          archiveBucketR2,
          archiveDbD1,
          classificationParseWorkflowBinding,
          investorTypeParseWorkflowBinding,
          above1ParseWorkflowBinding
        )
      )
    )
  )
