// The shareholding archive's bucket and Workflow over its bindings,
// SHAREHOLDING_ARCHIVE_BUCKET and SHAREHOLDING_ARCHIVE (alchemy.run.ts).
// Kept apart, so code that only uses the services never loads the adapters.
import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import { boundArchiveWorkflow } from "../archive/workflow-binding.ts"

export const archiveBucketR2 = r2ArchiveBucket(
  (env) => env.SHAREHOLDING_ARCHIVE_BUCKET
)

export const archiveWorkflowBinding = boundArchiveWorkflow(
  (env) => env.SHAREHOLDING_ARCHIVE
)
