// Fails when a package.json script pipes a command that can fail into another.
// npm runs scripts under sh, which has no pipefail: the producer's failure is
// hidden and the consumer runs on empty input. Capture the output instead:
//   out=$(producer) && printf '%s\n' "$out" | consumer
import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkPackageScripts } from "./package-scripts.mts"

runScript(Effect.flatMap(repoRoot, checkPackageScripts))
