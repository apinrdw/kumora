// The KSEI archive's bucket and Workflow over its bindings,
// KSEI_ARCHIVE_BUCKET and KSEI_ARCHIVE (alchemy.run.ts). Kept apart, so code
// that only uses the services never loads the adapters.
import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import { boundArchiveWorkflow } from "../archive/workflow-binding.ts"

export const kseiBucketR2 = r2ArchiveBucket((env) => env.KSEI_ARCHIVE_BUCKET)

export const kseiWorkflowBinding = boundArchiveWorkflow(
  (env) => env.KSEI_ARCHIVE
)
