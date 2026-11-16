// The classification parse run's Workflow, exported from the Worker entry
// (src/worker.ts) as `ClassificationParse`, the class the dashboard stack
// binds as CLASSIFICATION_PARSE.
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"

import { RunId } from "../archive/run.ts"
import { holdingsDbD1 } from "../holdings/db.ts"
import type { ParseParams } from "../holdings/parse-run-result.ts"
import { archiveBucketR2 } from "./bindings.ts"
import { classificationParseRuns } from "./classification-parse.ts"

export const ClassificationParse = makeWorkflow(
  Layer.merge(archiveBucketR2, holdingsDbD1),
  ({ id, startedAt, params }: WorkflowRun<ParseParams>, steps) =>
    classificationParseRuns.run(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)
