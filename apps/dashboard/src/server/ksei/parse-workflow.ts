// The KSEI parse run Workflow, exported from the Worker entry
// (src/worker.ts) as `KseiParse`, the class the dashboard stack binds as
// KSEI_PARSE.
import { parseWorkflowOf } from "../holdings/parse-workflow.ts"
import { kseiBucketR2 } from "./bindings.ts"
import { kseiParseRuns } from "./parse-runs.ts"

export const KseiParse = parseWorkflowOf(kseiParseRuns, kseiBucketR2)
