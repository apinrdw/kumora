// The archive cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. The bridge's runner logs a failure, as it does
// for every other callback, and settles instead of rejecting.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import {
  archiveBucketR2,
  archiveWorkflowBinding,
  classificationParseWorkflowBinding,
  investorTypeParseWorkflowBinding,
} from "./bindings.ts"
import { scheduledParseRuns } from "./parse-runs.ts"
import { scheduledArchiveRun } from "./runs.ts"

// Decision: returns a Promise, standing in for Cloudflare's `scheduled`,
// which CODING_STANDARDS exempts and which reaches this only through runCron
// (../crons.ts). It lives outside worker.ts so a test can run it without
// TanStack Start; returning the Effect would leave the runner the test covers
// in untested worker.ts. See apinrdw/kumora#308.
export const runArchiveCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledArchiveRun(scheduledTime).pipe(
      Effect.provide(Layer.merge(archiveBucketR2, archiveWorkflowBinding))
    )
  )

// The parse cron's handler, the same way: it starts a classification parse
// run and an investor-type parse run.
export const runParseCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledParseRuns(scheduledTime).pipe(
      Effect.provide(
        Layer.mergeAll(
          archiveBucketR2,
          classificationParseWorkflowBinding,
          investorTypeParseWorkflowBinding
        )
      )
    )
  )
