// Fails when the Release version files hold different versions, so a bump
// that missed one is caught on its PR, not when its Release tag is pushed.
import { Effect } from "effect"

import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"
import { checkReleaseVersions } from "./release-tag.mts"

runScript(Effect.flatMap(repoRoot, checkReleaseVersions))
