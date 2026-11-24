// The archive run Workflow, exported from the Worker entry (src/worker.ts) as
// `ShareholdingArchive`, the class the dashboard stack binds as
// SHAREHOLDING_ARCHIVE.
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { archiveDbD1 } from "../archive/archive-db.ts"
import { RunId } from "../archive/run.ts"
import { archiveRun } from "./archive-run.ts"
import { archiveBucketR2 } from "./bindings.ts"
import type { ArchiveParams } from "./run-result.ts"

export const ShareholdingArchive = makeWorkflow(
  Layer.mergeAll(archiveBucketR2, archiveDbD1, FetchHttpClient.layer),
  ({ id, startedAt, params }: WorkflowRun<ArchiveParams>, steps) =>
    archiveRun(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)
