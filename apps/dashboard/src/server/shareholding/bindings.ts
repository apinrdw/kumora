// The shareholding archive's bucket and Workflows over their bindings
// (alchemy.run.ts): SHAREHOLDING_ARCHIVE_BUCKET, SHAREHOLDING_ARCHIVE, and
// one per parse run kind (parse-runs.ts). Kept apart, so code that only uses
// the services never loads the adapters.
import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import {
  boundArchiveWorkflow,
  boundWorkflowAs,
} from "../archive/workflow-binding.ts"
import { Above1ParseWorkflow } from "./above-1-parse.ts"
import { Above5ParseWorkflow } from "./above-5-parse.ts"
import { ClassificationParseWorkflow } from "./classification-parse.ts"
import { InvestorTypeParseWorkflow } from "./investor-type-parse.ts"

export const archiveBucketR2 = r2ArchiveBucket(
  (env) => env.SHAREHOLDING_ARCHIVE_BUCKET
)

export const archiveWorkflowBinding = boundArchiveWorkflow(
  (env) => env.SHAREHOLDING_ARCHIVE
)

export const classificationParseWorkflowBinding = boundWorkflowAs(
  ClassificationParseWorkflow,
  (env) => env.CLASSIFICATION_PARSE
)

export const investorTypeParseWorkflowBinding = boundWorkflowAs(
  InvestorTypeParseWorkflow,
  (env) => env.INVESTOR_TYPE_PARSE
)

export const above1ParseWorkflowBinding = boundWorkflowAs(
  Above1ParseWorkflow,
  (env) => env.ABOVE_1_PARSE
)

export const above5ParseWorkflowBinding = boundWorkflowAs(
  Above5ParseWorkflow,
  (env) => env.ABOVE_5_PARSE
)
