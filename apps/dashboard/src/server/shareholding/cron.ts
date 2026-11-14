// The archive cron's handler, which the Worker entry's `scheduled` calls
// (src/worker.ts). The bridge's runner logs a failure, as it does for every
// other callback, and settles instead of rejecting.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveWorkflowBinding } from "./archive-workflow-binding.ts"
import { archiveBucketR2 } from "./bucket-r2.ts"
import { scheduledArchiveRun } from "./start-run.ts"

// Decision: a plain function returning a Promise, the exemption
// CODING_STANDARDS gives a callback a third party calls: this is the body of
// Cloudflare's `scheduled`, kept out of worker.ts so a test can run it
// without loading TanStack Start (apinrdw/kumora#308).
export const runArchiveCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledArchiveRun(scheduledTime).pipe(
      Effect.provide(Layer.merge(archiveBucketR2, archiveWorkflowBinding))
    )
  )
