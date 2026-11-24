// The Above-1% parse run: it parses the shareholding archive's holders-above-1%
// reports into ≥1% holders (../holdings/parse-runs.ts; which months,
// ../holdings/months-to-parse.ts). Spec apinrdw/kumora#479, "Above-1% parse
// run".
import { Context } from "effect"

import type { ArchiveWorkflow } from "../archive/workflow.ts"
import {
  ABOVE_1_TABLES,
  ABOVE_1_PARSER_VERSION,
  parseAbove1Month,
} from "../holdings/above-1.ts"
import { parseRunsOf } from "../holdings/parse-runs.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import { shareholdingIndex } from "./report-index.ts"

const KIND = "above-1"

// The Above-1% parse run's Workflow, ABOVE_1_PARSE (alchemy.run.ts).
export class Above1ParseWorkflow extends Context.Service<
  Above1ParseWorkflow,
  Context.Service.Shape<typeof ArchiveWorkflow>
>()("dashboard/shareholding/Above1ParseWorkflow") {}

export const above1ParseRuns = parseRunsOf({
  runName: "Above-1% parse run",
  // parse-runs/<kind>/, as keys.ts lays out.
  runsPrefix: `parse-runs/${KIND}/`,
  months: {
    prefix: kindPrefix(KIND),
    reportKey: (dataDate, sha256) => reportKey(KIND, dataDate, sha256),
    tables: ABOVE_1_TABLES,
    parserVersion: ABOVE_1_PARSER_VERSION,
    parse: parseAbove1Month,
  },
  newestVersions: shareholdingIndex.newestVersions(KIND),
  workflow: Above1ParseWorkflow,
})
