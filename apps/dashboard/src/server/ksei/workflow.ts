// The KSEI archive run Workflow, exported from the Worker entry
// (src/worker.ts) as `KseiArchive`, the class the dashboard stack binds as
// KSEI_ARCHIVE.
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"

import { RunId } from "../archive/run.ts"
import { kseiArchiveRun } from "./archive-run.ts"
import { kseiBucketR2 } from "./bindings.ts"
import { kseiHttp } from "./http.ts"
import type { KseiParams } from "./run-result.ts"

export const KseiArchive = makeWorkflow(
  Layer.merge(kseiBucketR2, kseiHttp),
  ({ id, startedAt, params }: WorkflowRun<KseiParams>, steps) =>
    kseiArchiveRun(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)
