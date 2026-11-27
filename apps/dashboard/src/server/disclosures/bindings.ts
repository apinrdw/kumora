// The disclosure archive's bucket and Workflow over their bindings,
// DISCLOSURE_ARCHIVE_BUCKET and DISCLOSURE_ARCHIVE (alchemy.run.ts). Kept
// apart, so code that only uses the services never loads the adapters.
import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import { boundArchiveWorkflow } from "../archive/workflow-binding.ts"

export const disclosureBucketR2 = r2ArchiveBucket(
  (env) => env.DISCLOSURE_ARCHIVE_BUCKET
)

export const disclosureWorkflowBinding = boundArchiveWorkflow(
  (env) => env.DISCLOSURE_ARCHIVE
)
