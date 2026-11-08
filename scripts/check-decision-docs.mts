import { Effect } from "effect"

import { checkDecisionDocs } from "./decision-docs.mts"
import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"

runScript(Effect.flatMap(repoRoot, checkDecisionDocs))
