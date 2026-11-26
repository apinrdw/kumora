// The disclosure cron's handler, which runCron (../crons.ts) calls for the
// Worker entry's `scheduled`. It returns a Promise for the reason the
// shareholding archive's (../shareholding/cron.ts) does.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveDbD1 } from "../archive/archive-db.ts"
import { disclosureBucketR2, disclosureWorkflowBinding } from "./bindings.ts"
import { scheduledDisclosureRun } from "./runs.ts"

// Decision: a cron runner returns a Promise, standing in for scheduled
// (apps/dashboard/docs/adr/0008-cron-runners-return-a-promise-for-scheduled.md)
export const runDisclosureCron = (scheduledTime: number) =>
  runServerEffectResult(
    scheduledDisclosureRun(scheduledTime).pipe(
      Effect.provide(
        Layer.mergeAll(
          disclosureBucketR2,
          archiveDbD1,
          disclosureWorkflowBinding
        )
      )
    )
  )
