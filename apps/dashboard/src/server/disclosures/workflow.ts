// The disclosure run Workflow, exported from the Worker entry
// (src/worker.ts) as `DisclosureArchive`, the class the dashboard stack
// binds as DISCLOSURE_ARCHIVE.
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"

import { archiveDbD1 } from "../archive/archive-db.ts"
import { RunId } from "../archive/run.ts"
import { disclosureRun } from "./archive-run.ts"
import { disclosureBucketR2 } from "./bindings.ts"
import { disclosureHttp } from "./http.ts"
import type { DisclosureParams } from "./run-result.ts"

export const DisclosureArchive = makeWorkflow(
  Layer.mergeAll(disclosureBucketR2, archiveDbD1, disclosureHttp),
  ({ id, startedAt, params }: WorkflowRun<DisclosureParams>, steps) =>
    disclosureRun(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)
