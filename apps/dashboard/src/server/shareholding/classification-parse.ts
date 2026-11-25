// The Classification parse run: it parses the shareholding archive's
// classification reports into classification holdings
// (../holdings/parse-runs.ts; which months, ../holdings/months-to-parse.ts).
// Spec apinrdw/kumora#402, "Parse runs".
import { Context } from "effect"

import type { ArchiveWorkflow } from "../archive/workflow.ts"
import {
  PARSER_VERSION,
  parseClassificationMonth,
  CLASSIFICATION_TABLES,
} from "../holdings/classification.ts"
import { parseCoverageByMonth } from "../holdings/parse-coverage.ts"
import { parseRunsOf } from "../holdings/parse-runs.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import { shareholdingIndex } from "./report-index.ts"

const KIND = "investor-classification"

// The Classification parse run's Workflow, CLASSIFICATION_PARSE
// (alchemy.run.ts).
export class ClassificationParseWorkflow extends Context.Service<
  ClassificationParseWorkflow,
  Context.Service.Shape<typeof ArchiveWorkflow>
>()("dashboard/shareholding/ClassificationParseWorkflow") {}

export const classificationParseRuns = parseRunsOf({
  runName: "Classification parse run",
  // parse-runs/<kind>/, as keys.ts lays out.
  archive: "shareholding",
  runKind: `parse-${KIND}`,
  runsPrefix: `parse-runs/${KIND}/`,
  months: {
    prefix: kindPrefix(KIND),
    reportKey: (dataDate, sha256) => reportKey(KIND, dataDate, sha256),
    tables: CLASSIFICATION_TABLES,
    parserVersion: PARSER_VERSION,
    parse: parseClassificationMonth,
  },
  newestVersions: shareholdingIndex.newestVersions(KIND),
  coverageLayout: parseCoverageByMonth,
  workflow: ClassificationParseWorkflow,
})
