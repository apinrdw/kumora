// The shareholding archive's parse runs' Workflows, one per kind
// (parse-runs.ts), exported from the Worker entry (src/worker.ts) as the
// classes the dashboard stack binds (alchemy.run.ts).
import { parseWorkflowOf } from "../holdings/parse-workflow.ts"
import { above1ParseRuns } from "./above-1-parse.ts"
import { above5ParseRuns } from "./above-5-parse.ts"
import { archiveBucketR2 } from "./bindings.ts"
import { classificationParseRuns } from "./classification-parse.ts"
import { investorTypeParseRuns } from "./investor-type-parse.ts"

export const ClassificationParse = parseWorkflowOf(
  classificationParseRuns,
  archiveBucketR2
)

export const InvestorTypeParse = parseWorkflowOf(
  investorTypeParseRuns,
  archiveBucketR2
)

export const Above1Parse = parseWorkflowOf(above1ParseRuns, archiveBucketR2)

export const Above5Parse = parseWorkflowOf(above5ParseRuns, archiveBucketR2)
