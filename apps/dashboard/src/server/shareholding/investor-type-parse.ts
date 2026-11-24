// The Investor-type parse run: it parses the shareholding archive's
// investor-type reports into investor-type holdings
// (../holdings/parse-runs.ts; which months, ../holdings/months-to-parse.ts).
// Spec apinrdw/kumora#402, "Parse runs".
import { Context } from "effect"

import type { ArchiveWorkflow } from "../archive/workflow.ts"
import {
  PARSER_VERSION,
  parseInvestorTypeMonth,
  INVESTOR_TYPE_TABLES,
} from "../holdings/investor-type.ts"
import { parseRunsOf } from "../holdings/parse-runs.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import { shareholdingNewestVersions } from "./report-index.ts"

const KIND = "investor-type"

// The Investor-type parse run's Workflow, INVESTOR_TYPE_PARSE
// (alchemy.run.ts).
export class InvestorTypeParseWorkflow extends Context.Service<
  InvestorTypeParseWorkflow,
  Context.Service.Shape<typeof ArchiveWorkflow>
>()("dashboard/shareholding/InvestorTypeParseWorkflow") {}

export const investorTypeParseRuns = parseRunsOf({
  runName: "Investor-type parse run",
  // parse-runs/<kind>/, as keys.ts lays out.
  archive: "shareholding",
  runKind: `parse-${KIND}`,
  runsPrefix: `parse-runs/${KIND}/`,
  months: {
    prefix: kindPrefix(KIND),
    indexed: shareholdingNewestVersions(KIND),
    reportKey: (dataDate, sha256) => reportKey(KIND, dataDate, sha256),
    tables: INVESTOR_TYPE_TABLES,
    parserVersion: PARSER_VERSION,
    parse: parseInvestorTypeMonth,
  },
  workflow: InvestorTypeParseWorkflow,
})
