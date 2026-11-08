import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkOxlintOverrides } from "./oxlint-overrides.mts"

runScript(Effect.flatMap(repoRoot, checkOxlintOverrides))
