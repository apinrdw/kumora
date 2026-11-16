// The KSEI parse run Workflow, exported from the Worker entry
// (src/worker.ts) as `KseiParse`, the class the dashboard stack binds as
// KSEI_PARSE.
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"

import { RunId } from "../archive/run.ts"
import { holdingsDbD1 } from "../holdings/db.ts"
import { kseiBucketR2 } from "./bindings.ts"
import type { ParseParams } from "../holdings/parse-run-result.ts"
import { kseiParseRuns } from "./parse-runs.ts"

export const KseiParse = makeWorkflow(
  Layer.merge(kseiBucketR2, holdingsDbD1),
  ({ id, startedAt, params }: WorkflowRun<ParseParams>, steps) =>
    kseiParseRuns.run(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)
