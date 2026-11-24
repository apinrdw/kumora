// The KSEI parse run (../holdings/parse-runs.ts): it parses the KSEI
// archive's Kepemilikan Efek months into parsed holdings, reading only the
// KSEI archive's bucket and HoldingsDb, and keeps its runs under parse-runs/
// in that bucket. The first run parses every held month, from the archive's
// first (FIRST_MONTH, coverage.ts). Spec apinrdw/kumora#363, "KSEI parse
// run".
import { Context } from "effect"

import type { ArchiveWorkflow } from "../archive/workflow.ts"
import {
  KSEI_PARSER_VERSION,
  KSEI_TABLES,
  parseKseiMonth,
} from "../holdings/ksei.ts"
import { parseRunsOf } from "../holdings/parse-runs.ts"
import { kindPrefix, reportKey } from "./keys.ts"
import { kseiNewestVersions } from "./report-index.ts"

const KIND = "securities-holdings"

// The KSEI parse run's Workflow, KSEI_PARSE (alchemy.run.ts).
export class KseiParseWorkflow extends Context.Service<
  KseiParseWorkflow,
  Context.Service.Shape<typeof ArchiveWorkflow>
>()("dashboard/ksei/KseiParseWorkflow") {}

export const kseiParseRuns = parseRunsOf({
  runName: "KSEI parse run",
  archive: "ksei",
  runKind: `parse-${KIND}`,
  runsPrefix: "parse-runs/",
  months: {
    prefix: kindPrefix(KIND),
    indexed: kseiNewestVersions(KIND),
    reportKey: (periodEnd, sha256) => reportKey(KIND, periodEnd, sha256),
    tables: KSEI_TABLES,
    parserVersion: KSEI_PARSER_VERSION,
    parse: parseKseiMonth,
  },
  workflow: KseiParseWorkflow,
})
