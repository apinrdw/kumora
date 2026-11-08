import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkSkillLinks } from "./skill-links.mts"

runScript(Effect.flatMap(repoRoot, checkSkillLinks))
