// The Above-5% parse run: it parses the shareholding archive's daily
// holders-above-5% reports into above-5% holders (../holdings/parse-runs.ts;
// which days, ../holdings/months-to-parse.ts, where a month is a trading day
// here). Spec apinrdw/kumora#673, "Above-5% parse run".
import { Context } from "effect"

import type { ArchiveWorkflow } from "../archive/workflow.ts"
import {
  ABOVE_5_TABLES,
  ABOVE_5_PARSER_VERSION,
  parseAbove5Day,
} from "../holdings/above-5.ts"
import { parseCoverageByDay } from "../holdings/parse-coverage.ts"
import { parseRunsOf } from "../holdings/parse-runs.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import { shareholdingIndex } from "./report-index.ts"

const KIND = "above-5"

// The Above-5% parse run's Workflow, ABOVE_5_PARSE (alchemy.run.ts).
export class Above5ParseWorkflow extends Context.Service<
  Above5ParseWorkflow,
  Context.Service.Shape<typeof ArchiveWorkflow>
>()("dashboard/shareholding/Above5ParseWorkflow") {}

export const above5ParseRuns = parseRunsOf({
  runName: "Above-5% parse run",
  // parse-runs/<kind>/, as keys.ts lays out.
  archive: "shareholding",
  runKind: `parse-${KIND}`,
  runsPrefix: `parse-runs/${KIND}/`,
  months: {
    prefix: kindPrefix(KIND),
    reportKey: (dataDate, sha256) => reportKey(KIND, dataDate, sha256),
    tables: ABOVE_5_TABLES,
    parserVersion: ABOVE_5_PARSER_VERSION,
    parse: parseAbove5Day,
  },
  newestVersions: shareholdingIndex.newestVersions(KIND),
  coverageLayout: parseCoverageByDay,
  workflow: Above5ParseWorkflow,
})
