import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkVpVersion } from "./vp-version.mts"

runScript(Effect.flatMap(repoRoot, checkVpVersion))
