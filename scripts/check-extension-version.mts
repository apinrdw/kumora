import { Effect } from "effect"

import { checkExtensionVersion, baseRef } from "./extension-version.mts"
import { repoRoot } from "./lib/check.mts"
import { runScript } from "./lib/run.mts"

runScript(
  Effect.gen(function* () {
    yield* checkExtensionVersion(yield* repoRoot, yield* baseRef)
  })
)
