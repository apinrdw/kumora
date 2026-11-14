// The archive cron's handler, which the Worker entry's `scheduled` calls
// (src/worker.ts). The bridge's runner logs a failure, as it does for every
// other callback, and settles instead of rejecting.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveWorkflowBinding } from "./archive-workflow-binding.ts"
import { archiveBucketR2 } from "./bucket-r2.ts"
import { scheduledArchiveRun } from "./start-run.ts"

// Decision: returns a Promise, standing in for Cloudflare's `scheduled`,
// which CODING_STANDARDS exempts and which only calls this. It lives outside
// worker.ts so a test can run it without TanStack Start; returning the Effect
// would leave the runner the test covers in untested worker.ts. See
// apinrdw/kumora#308.
export const runArchiveCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledArchiveRun(scheduledTime).pipe(
      Effect.provide(Layer.merge(archiveBucketR2, archiveWorkflowBinding))
    )
  )
