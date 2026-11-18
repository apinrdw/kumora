// The shareholding archive's parse runs' Workflows, exported from the Worker
// entry (src/worker.ts): the classification parse run's as
// `ClassificationParse`, the class the dashboard stack binds as
// CLASSIFICATION_PARSE, the investor-type parse run's as
// `InvestorTypeParse`, bound as INVESTOR_TYPE_PARSE, and the above-1% parse
// run's as `Above1Parse`, bound as ABOVE_1_PARSE.
import { parseWorkflowOf } from "../holdings/parse-workflow.ts"
import { above1ParseRuns } from "./above-1-parse.ts"
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
