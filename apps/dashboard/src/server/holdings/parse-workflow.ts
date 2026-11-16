// A parse run's Workflow class (parse-runs.ts), over its archive's bucket
// and HoldingsDb. Only the Worker entry's Workflow modules import it, since
// it loads `cloudflare:workers`.
import type { WorkerEnv } from "@workspace/server"
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"

import type { ArchiveBucket } from "../archive/bucket.ts"
import { RunId } from "../archive/run.ts"
import { holdingsDbD1 } from "./db.ts"
import type { ParseParams } from "./parse-run-result.ts"
import type { ParseRuns } from "./parse-runs.ts"

export const parseWorkflowOf = <Self>(
  runs: ParseRuns<Self>,
  bucket: Layer.Layer<ArchiveBucket, never, WorkerEnv>
) =>
  makeWorkflow(
    Layer.merge(bucket, holdingsDbD1),
    ({ id, startedAt, params }: WorkflowRun<ParseParams>, steps) =>
      runs.run(steps, {
        id: RunId.make(id),
        startedAt,
        trigger: params.trigger,
      })
  )
