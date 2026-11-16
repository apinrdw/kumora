// The shareholding archive's parse runs' Workflows, exported from the Worker
// entry (src/worker.ts): the classification parse run's as
// `ClassificationParse`, the class the dashboard stack binds as
// CLASSIFICATION_PARSE, and the investor-type parse run's as
// `InvestorTypeParse`, bound as INVESTOR_TYPE_PARSE.
import { makeWorkflow, type WorkflowRun } from "@workspace/server/workflow"
import { Layer } from "effect"

import { RunId } from "../archive/run.ts"
import { holdingsDbD1 } from "../holdings/db.ts"
import type { ParseParams } from "../holdings/parse-run-result.ts"
import { archiveBucketR2 } from "./bindings.ts"
import { classificationParseRuns } from "./classification-parse.ts"
import { investorTypeParseRuns } from "./investor-type-parse.ts"

export const ClassificationParse = makeWorkflow(
  Layer.merge(archiveBucketR2, holdingsDbD1),
  ({ id, startedAt, params }: WorkflowRun<ParseParams>, steps) =>
    classificationParseRuns.run(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)

export const InvestorTypeParse = makeWorkflow(
  Layer.merge(archiveBucketR2, holdingsDbD1),
  ({ id, startedAt, params }: WorkflowRun<ParseParams>, steps) =>
    investorTypeParseRuns.run(steps, {
      id: RunId.make(id),
      startedAt,
      trigger: params.trigger,
    })
)
