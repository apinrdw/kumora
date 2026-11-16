// The shareholding archive's bucket and Workflows over their bindings,
// SHAREHOLDING_ARCHIVE_BUCKET, SHAREHOLDING_ARCHIVE, CLASSIFICATION_PARSE and
// INVESTOR_TYPE_PARSE (alchemy.run.ts). Kept apart, so code that only uses the services never
// loads the adapters.
import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import {
  boundArchiveWorkflow,
  boundWorkflowAs,
} from "../archive/workflow-binding.ts"
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
