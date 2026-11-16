// The shareholding archive's parse runs' Workflows, exported from the Worker
// entry (src/worker.ts): the classification parse run's as
// `ClassificationParse`, the class the dashboard stack binds as
// CLASSIFICATION_PARSE, and the investor-type parse run's as
// `InvestorTypeParse`, bound as INVESTOR_TYPE_PARSE.
import { parseWorkflowOf } from "../holdings/parse-workflow.ts"
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
