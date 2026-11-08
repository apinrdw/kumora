import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkNoGitlinks } from "./no-gitlinks.mts"

runScript(Effect.flatMap(repoRoot, checkNoGitlinks))
