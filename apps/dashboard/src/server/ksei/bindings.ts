// The KSEI archive's bucket and Workflows over their bindings,
// KSEI_ARCHIVE_BUCKET, KSEI_ARCHIVE and KSEI_PARSE (alchemy.run.ts). Kept
// apart, so code that only uses the services never loads the adapters.
import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import {
  boundArchiveWorkflow,
  boundWorkflowAs,
} from "../archive/workflow-binding.ts"
import { KseiParseWorkflow } from "./parse-runs.ts"

export const kseiBucketR2 = r2ArchiveBucket((env) => env.KSEI_ARCHIVE_BUCKET)

export const kseiWorkflowBinding = boundArchiveWorkflow(
  (env) => env.KSEI_ARCHIVE
)

export const kseiParseWorkflowBinding = boundWorkflowAs(
  KseiParseWorkflow,
  (env) => env.KSEI_PARSE
)
